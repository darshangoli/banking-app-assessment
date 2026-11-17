"use strict";

const { ok, badRequest, notFound, conflict, serverError, parseJsonBody } = require("../lib/response");
const { docClient, TABLES } = require("../lib/dynamodb");
const { GetCommand, UpdateCommand, TransactWriteCommand } = require("@aws-sdk/lib-dynamodb");
const { validateAmount } = require("../lib/validate");
const {
  buildIdempotencyClaimItem,
  resolveIdempotency,
  checkIdempotency,
  waitForResolution,
} = require("../lib/idempotency");

const VALID_CURRENCIES = new Set(["CAD", "USD"]);

/**
 * Fetches an account from DynamoDB. Returns the Item or null.
 * Throws on unexpected errors.
 */
async function fetchAccount(accountId) {
  const result = await docClient.send(
    new GetCommand({
      TableName: TABLES.accounts,
      Key: { accountId },
    })
  );
  return result.Item ?? null;
}

/**
 * Extracts the Idempotency-Key header (case-insensitive).
 * API Gateway lowercases headers; serverless-offline preserves case.
 */
function extractIdempotencyKey(event) {
  const headers = event.headers ?? {};
  return headers["idempotency-key"] || headers["Idempotency-Key"] || null;
}

/**
 * Core idempotency gate used by all three write handlers.
 *
 * Flow:
 *  1. If key already DONE  → return cached response immediately (safe retry)
 *  2. If key PROCESSING    → another request is in flight; wait for it to DONE
 *  3. If NOT_FOUND         → build & execute a TransactWriteCommand that atomically
 *                            claims the key (Put with attribute_not_exists) AND
 *                            runs the business operation (balance update).
 *                            Only ONE request wins this race.
 *  4. Loser of the race    → TransactionCanceledException on the idempotency Put
 *                            → wait for the winner to resolve, then return its response.
 *  5. Winner               → resolve idempotency record to DONE with the HTTP response.
 *
 * @param {string|null} key          - Idempotency-Key from the request header
 * @param {function}    buildItems   - Returns the non-idempotency TransactItems[]
 * @param {function}    buildResponse- Builds the success HTTP response from the transaction result
 */
async function runWithIdempotency(key, buildItems, buildResponse) {
  // ── No idempotency key supplied — just run the transaction normally ──────
  if (!key) {
    try {
      const result = await docClient.send(
        new TransactWriteCommand({ TransactItems: buildItems() })
      );
      return buildResponse(result);
    } catch (err) {
      return handleTransactionError(err);
    }
  }

  // ── Check whether we've seen this key before ─────────────────────────────
  let check;
  try {
    check = await checkIdempotency(key);
  } catch (err) {
    console.error("Idempotency check failed:", err);
    // Non-fatal: fall through and treat as NOT_FOUND
    check = { state: "NOT_FOUND" };
  }

  if (check.state === "DONE") {
    return check.response; // Safe replay — no DB write
  }

  if (check.state === "PROCESSING") {
    // Another request is already in flight with this key — wait for it
    const resolved = await waitForResolution(key);
    if (resolved) return resolved;
    // Winner crashed before resolving — tell client to use a fresh key
    return conflict(
      "A concurrent request with this Idempotency-Key is still processing. " +
      "Please retry with a new Idempotency-Key."
    );
  }

  // ── First time seeing this key — build the atomic transaction ────────────
  // Bundle: [claim idempotency key] + [business operation items]
  const transactItems = [
    { Put: buildIdempotencyClaimItem(key) },
    ...buildItems(),
  ];

  let result;
  try {
    result = await docClient.send(
      new TransactWriteCommand({ TransactItems: transactItems })
    );
  } catch (err) {
    // Check whether the idempotency Put was the one that failed (we lost the race)
    if (
      err.name === "TransactionCanceledException" &&
      err.CancellationReasons?.[0]?.Code === "ConditionalCheckFailed"
    ) {
      // We lost the race — the first TransactItem (idempotency Put) was rejected.
      // Wait for the winner to write its DONE response.
      const resolved = await waitForResolution(key);
      if (resolved) return resolved;
      return conflict(
        "A concurrent request with this Idempotency-Key is still processing. " +
        "Please retry with a new Idempotency-Key."
      );
    }
    // Otherwise it's a business-logic failure (insufficient funds, closed account, etc.)
    return handleTransactionError(err);
  }

  // ── We won — build the response and persist it ───────────────────────────
  const response = buildResponse(result);

  try {
    await resolveIdempotency(key, response);
  } catch (err) {
    // Should not happen in practice, but log and continue — the money already moved.
    console.error("Failed to resolve idempotency record:", err);
  }

  return response;
}

/**
 * Translates a TransactionCanceledException into an appropriate HTTP response.
 * The idempotency Put is always index 0 when present — business conditions
 * start at index 1 for deposit/withdraw and indices 1-2 for transfer.
 */
function handleTransactionError(err) {
  if (err.name === "TransactionCanceledException") {
    const reasons = err.CancellationReasons ?? [];
    // Business condition failed (insufficient funds or account not OPEN)
    if (reasons.some((r) => r.Code === "ConditionalCheckFailed")) {
      return conflict("Insufficient funds or account is no longer OPEN");
    }
  }
  console.error("DynamoDB transaction failed:", err);
  return serverError("Transaction failed");
}

// ─────────────────────────────────────────────────────────────────────────────
// DEPOSIT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /accounts/{accountId}/deposits
 *
 * Credits the account balance.
 * - amount must be > 0 with at most 2 decimal places
 * - currency must match the account's currency
 * - account must be OPEN
 * - Idempotency-Key header atomically prevents double-credits on retry
 * - Returns 200 with the updated Account
 */
async function deposit(event) {
  const accountId = event.pathParameters?.accountId;
  if (!accountId) return badRequest("accountId path parameter is required");

  const parsed = parseJsonBody(event);
  if (!parsed.ok) return parsed.response;

  const { currency } = parsed.data;
  if (!currency || !VALID_CURRENCIES.has(currency)) {
    return badRequest(`currency must be one of: ${[...VALID_CURRENCIES].join(", ")}`);
  }

  const amtResult = validateAmount(parsed.data.amount);
  if (!amtResult.ok) return badRequest(amtResult.message);
  const amt = amtResult.value;

  // Validate account exists and is eligible before entering the transaction
  let account;
  try {
    account = await fetchAccount(accountId);
  } catch (err) {
    console.error("DynamoDB GetCommand failed (deposit pre-check):", err);
    return serverError("Failed to fetch account");
  }
  if (!account) return notFound(`Account '${accountId}' not found`);
  if (account.status !== "OPEN") {
    return conflict(`Account '${accountId}' is ${account.status} and cannot accept deposits`);
  }
  if (account.currency !== currency) {
    return badRequest(
      `Currency mismatch: account currency is ${account.currency}, request currency is ${currency}`
    );
  }

  const idempotencyKey = extractIdempotencyKey(event);

  return runWithIdempotency(
    idempotencyKey,

    // TransactItems builder (index 0 is reserved for the idempotency Put when key is set)
    () => [
      {
        Update: {
          TableName: TABLES.accounts,
          Key: { accountId },
          UpdateExpression: "SET balance = balance + :amt",
          ConditionExpression: "#status = :open",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":amt": amt, ":open": "OPEN" },
        },
      },
    ],

    // Response builder — compute new balance from known pre-tx value
    () => ok({ ...account, balance: Math.round((account.balance + amt) * 100) / 100 })
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// WITHDRAW
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /accounts/{accountId}/withdrawals
 *
 * Debits the account balance.
 * - amount must be > 0 with at most 2 decimal places
 * - currency must match the account's currency
 * - account must be OPEN
 * - Returns 409 if balance < amount (insufficient funds)
 * - Idempotency-Key header atomically prevents double-debits on retry
 * - Returns 200 with the updated Account
 */
async function withdraw(event) {
  const accountId = event.pathParameters?.accountId;
  if (!accountId) return badRequest("accountId path parameter is required");

  const parsed = parseJsonBody(event);
  if (!parsed.ok) return parsed.response;

  const { currency } = parsed.data;
  if (!currency || !VALID_CURRENCIES.has(currency)) {
    return badRequest(`currency must be one of: ${[...VALID_CURRENCIES].join(", ")}`);
  }

  const amtResult = validateAmount(parsed.data.amount);
  if (!amtResult.ok) return badRequest(amtResult.message);
  const amt = amtResult.value;

  let account;
  try {
    account = await fetchAccount(accountId);
  } catch (err) {
    console.error("DynamoDB GetCommand failed (withdraw pre-check):", err);
    return serverError("Failed to fetch account");
  }
  if (!account) return notFound(`Account '${accountId}' not found`);
  if (account.status !== "OPEN") {
    return conflict(`Account '${accountId}' is ${account.status} and cannot accept withdrawals`);
  }
  if (account.currency !== currency) {
    return badRequest(
      `Currency mismatch: account currency is ${account.currency}, request currency is ${currency}`
    );
  }

  const idempotencyKey = extractIdempotencyKey(event);

  return runWithIdempotency(
    idempotencyKey,

    () => [
      {
        Update: {
          TableName: TABLES.accounts,
          Key: { accountId },
          UpdateExpression: "SET balance = balance - :amt",
          // Atomically: account still OPEN AND has sufficient funds
          ConditionExpression: "#status = :open AND balance >= :amt",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":amt": amt, ":open": "OPEN" },
        },
      },
    ],

    () => ok({ ...account, balance: Math.round((account.balance - amt) * 100) / 100 })
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TRANSFER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /transfers
 *
 * Moves funds between two accounts atomically.
 * - Idempotency-Key atomically prevents double-transfers on retry
 * - Both accounts must be OPEN and share the same currency
 * - Returns 200: { fromAccount, toAccount }
 */
async function transfer(event) {
  const parsed = parseJsonBody(event);
  if (!parsed.ok) return parsed.response;

  const { fromAccountId, toAccountId, currency } = parsed.data;

  if (!fromAccountId || typeof fromAccountId !== "string") return badRequest("fromAccountId is required");
  if (!toAccountId || typeof toAccountId !== "string") return badRequest("toAccountId is required");
  if (fromAccountId === toAccountId) return badRequest("fromAccountId and toAccountId must be different");
  if (!currency || !VALID_CURRENCIES.has(currency)) {
    return badRequest(`currency must be one of: ${[...VALID_CURRENCIES].join(", ")}`);
  }

  const amtResult = validateAmount(parsed.data.amount);
  if (!amtResult.ok) return badRequest(amtResult.message);
  const amt = amtResult.value;

  let fromAccount, toAccount;
  try {
    [fromAccount, toAccount] = await Promise.all([
      fetchAccount(fromAccountId),
      fetchAccount(toAccountId),
    ]);
  } catch (err) {
    console.error("DynamoDB GetCommand failed (transfer pre-check):", err);
    return serverError("Failed to fetch accounts");
  }

  if (!fromAccount) return notFound(`Source account '${fromAccountId}' not found`);
  if (!toAccount) return notFound(`Destination account '${toAccountId}' not found`);

  if (fromAccount.status !== "OPEN") {
    return conflict(`Source account '${fromAccountId}' is ${fromAccount.status} and cannot send transfers`);
  }
  if (toAccount.status !== "OPEN") {
    return conflict(`Destination account '${toAccountId}' is ${toAccount.status} and cannot receive transfers`);
  }
  if (fromAccount.currency !== currency) {
    return badRequest(`Currency mismatch: source account currency is ${fromAccount.currency}`);
  }
  if (toAccount.currency !== currency) {
    return badRequest(`Currency mismatch: destination account currency is ${toAccount.currency}`);
  }

  const idempotencyKey = extractIdempotencyKey(event);

  return runWithIdempotency(
    idempotencyKey,

    () => [
      {
        Update: {
          TableName: TABLES.accounts,
          Key: { accountId: fromAccountId },
          UpdateExpression: "SET balance = balance - :amt",
          ConditionExpression: "#status = :open AND balance >= :amt",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":amt": amt, ":open": "OPEN" },
        },
      },
      {
        Update: {
          TableName: TABLES.accounts,
          Key: { accountId: toAccountId },
          UpdateExpression: "SET balance = balance + :amt",
          ConditionExpression: "#status = :open",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":amt": amt, ":open": "OPEN" },
        },
      },
    ],

    () => ok({
      fromAccount: { ...fromAccount, balance: Math.round((fromAccount.balance - amt) * 100) / 100 },
      toAccount:   { ...toAccount,   balance: Math.round((toAccount.balance   + amt) * 100) / 100 },
    })
  );
}

module.exports = { deposit, withdraw, transfer };
