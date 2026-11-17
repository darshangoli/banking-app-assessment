"use strict";

const { ok, badRequest, notFound, conflict, serverError, parseJsonBody } = require("../lib/response");
const { docClient, TABLES } = require("../lib/dynamodb");
const { GetCommand, TransactWriteCommand } = require("@aws-sdk/lib-dynamodb");
const { validateAmount } = require("../lib/validate");
const {
  buildIdempotencyClaimItem,
  resolveIdempotency,
  checkIdempotency,
  waitForResolution,
} = require("../lib/idempotency");

const VALID_CURRENCIES = new Set(["CAD", "USD"]);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function fetchAccount(accountId) {
  const result = await docClient.send(
    new GetCommand({ TableName: TABLES.accounts, Key: { accountId } })
  );
  return result.Item ?? null;
}

function extractIdempotencyKey(event) {
  const h = event.headers ?? {};
  return h["idempotency-key"] || h["Idempotency-Key"] || null;
}

/**
 * Core idempotency gate used by all three write handlers.
 *
 * @param {string|null} key
 *   Idempotency-Key from the request header; null = skip idempotency.
 *
 * @param {function} buildTransactItems
 *   Returns the array of TransactItems for the business operation (without
 *   the idempotency Put — that is prepended automatically when key is set).
 *
 * @param {object} recoveryMeta
 *   Crash-recovery metadata stored inside the PROCESSING record so that
 *   waitForResolution() can self-heal if the winner Lambda crashes:
 *     verifyAccountId       — account to read to confirm the tx ran
 *     verifyExpectedBalance — balance value that proves the tx ran
 *     recoveryStatusCode    — HTTP status to replay on self-heal
 *     recoveryBody          — JSON body string to replay on self-heal
 *
 * @param {function} buildSuccessResponse
 *   Builds the final HTTP response object after a winning transaction.
 */
async function runWithIdempotency(key, buildTransactItems, recoveryMeta, buildSuccessResponse) {

  // ── No key: plain transaction, no idempotency overhead ───────────────────
  if (!key) {
    try {
      await docClient.send(
        new TransactWriteCommand({ TransactItems: buildTransactItems() })
      );
    } catch (err) {
      return handleTransactionError(err, 1); // business items start at index 0
    }
    return buildSuccessResponse();
  }

  // ── Key present: check cache first (fast-path for already-resolved retries) ─
  let check;
  try {
    check = await checkIdempotency(key);
  } catch (err) {
    console.error("Idempotency check failed:", err);
    check = { state: "NOT_FOUND" };
  }

  if (check.state === "DONE") {
    return check.response; // ← safe replay, no DB write
  }

  if (check.state === "PROCESSING") {
    // Another request is in-flight (or the winner crashed).
    // waitForResolution polls for DONE and also runs crash-recovery.
    const resolved = await waitForResolution(key);
    if (resolved) return resolved;
    return conflict(
      "A concurrent request with this Idempotency-Key is still processing. " +
      "Please retry with a new Idempotency-Key."
    );
  }

  // ── First time seeing this key: build atomic transaction ─────────────────
  //
  // TransactItems layout:
  //   [0]  idempotency Put  (attribute_not_exists condition — the race lock)
  //   [1+] business operation items (balance Update, etc.)
  //
  // If two requests race here, only ONE transaction succeeds.
  // The loser gets TransactionCanceledException with
  // CancellationReasons[0].Code = "ConditionalCheckFailed".
  // Because item[0] and item[1+] are in the SAME transaction, the loser's
  // balance Update is also cancelled — zero double-charge (Problems 1 & 2).

  const transactItems = [
    { Put: buildIdempotencyClaimItem(key, recoveryMeta) },
    ...buildTransactItems(),
  ];

  try {
    await docClient.send(new TransactWriteCommand({ TransactItems: transactItems }));
  } catch (err) {
    if (
      err.name === "TransactionCanceledException" &&
      err.CancellationReasons?.[0]?.Code === "ConditionalCheckFailed"
    ) {
      // We lost the race on the idempotency Put (item[0]).
      // Wait for the winner to resolve, then replay its response.
      const resolved = await waitForResolution(key);
      if (resolved) return resolved;
      return conflict(
        "A concurrent request with this Idempotency-Key is still processing. " +
        "Please retry with a new Idempotency-Key."
      );
    }
    // Business-logic failure (insufficient funds, closed account, etc.)
    // Business items start at index 1 when idempotency is included.
    return handleTransactionError(err, 1);
  }

  // ── We won the race: build response and resolve the PROCESSING record ─────
  //
  // The window between here and resolveIdempotency() is the only remaining
  // crash risk (Problem 3).  It is handled by crash-recovery in
  // waitForResolution() using the verifyExpectedBalance stored in the
  // PROCESSING record above — if the winner crashes here, the next caller
  // that times out will read the account balance, confirm it matches
  // verifyExpectedBalance, and self-resolve the record to DONE.

  const response = buildSuccessResponse();

  try {
    await resolveIdempotency(key, response);
  } catch (err) {
    // Should not happen in practice, but the money already moved safely.
    // Log and continue — crash-recovery will self-heal on the next retry.
    console.error("Failed to resolve idempotency record after winning transaction:", err);
  }

  return response;
}

/**
 * Maps a TransactionCanceledException to the right HTTP response.
 * `businessStartIndex` is the offset in CancellationReasons where the
 * business items begin (1 when idempotency Put is item[0], 0 otherwise).
 */
function handleTransactionError(err, businessStartIndex = 0) {
  if (err.name === "TransactionCanceledException") {
    const reasons = (err.CancellationReasons ?? []).slice(businessStartIndex);
    if (reasons.some((r) => r.Code === "ConditionalCheckFailed")) {
      return conflict("Insufficient funds or account is no longer OPEN");
    }
  }
  console.error("DynamoDB transaction failed:", err);
  return serverError("Transaction failed");
}

// ─────────────────────────────────────────────────────────────────────────────
// DEPOSIT  POST /accounts/{accountId}/deposits
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Credits the account balance.
 * - amount > 0, max 2 decimal places
 * - currency must match account currency
 * - account must be OPEN
 * - Idempotency-Key atomically prevents double-credits on retry or race
 * - Crash-safe: if Lambda dies after the transaction, the next retry
 *   self-heals by verifying the account balance
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

  const expectedBalance = Math.round((account.balance + amt) * 100) / 100;
  const successResponse  = ok({ ...account, balance: expectedBalance });

  return runWithIdempotency(
    extractIdempotencyKey(event),

    // Business TransactItems
    () => [{
      Update: {
        TableName: TABLES.accounts,
        Key: { accountId },
        UpdateExpression: "SET balance = balance + :amt",
        ConditionExpression: "#status = :open",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":amt": amt, ":open": "OPEN" },
      },
    }],

    // Crash-recovery metadata stored in the PROCESSING record
    {
      verifyAccountId:       accountId,
      verifyExpectedBalance: expectedBalance,
      recoveryStatusCode:    successResponse.statusCode,
      recoveryBody:          successResponse.body,
    },

    // Success response builder
    () => successResponse
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// WITHDRAW  POST /accounts/{accountId}/withdrawals
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Debits the account balance.
 * - amount > 0, max 2 decimal places
 * - currency must match account currency
 * - account must be OPEN
 * - Returns 409 if balance < amount (insufficient funds)
 * - Idempotency-Key atomically prevents double-debits on retry or race
 * - Crash-safe: self-heals on the next retry via balance verification
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

  const expectedBalance = Math.round((account.balance - amt) * 100) / 100;
  const successResponse  = ok({ ...account, balance: expectedBalance });

  return runWithIdempotency(
    extractIdempotencyKey(event),

    () => [{
      Update: {
        TableName: TABLES.accounts,
        Key: { accountId },
        UpdateExpression: "SET balance = balance - :amt",
        // Atomically: account still OPEN AND has sufficient funds
        ConditionExpression: "#status = :open AND balance >= :amt",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":amt": amt, ":open": "OPEN" },
      },
    }],

    {
      verifyAccountId:       accountId,
      verifyExpectedBalance: expectedBalance,
      recoveryStatusCode:    successResponse.statusCode,
      recoveryBody:          successResponse.body,
    },

    () => successResponse
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TRANSFER  POST /transfers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Moves funds between two accounts atomically.
 * - Both accounts must be OPEN and share the same currency
 * - Idempotency-Key atomically prevents double-transfers on retry or race
 * - Crash-safe: verifies the source account balance for self-healing
 * - Returns 200: { fromAccount, toAccount }
 */
async function transfer(event) {
  const parsed = parseJsonBody(event);
  if (!parsed.ok) return parsed.response;

  const { fromAccountId, toAccountId, currency } = parsed.data;

  if (!fromAccountId || typeof fromAccountId !== "string") return badRequest("fromAccountId is required");
  if (!toAccountId   || typeof toAccountId   !== "string") return badRequest("toAccountId is required");
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
  if (!toAccount)   return notFound(`Destination account '${toAccountId}' not found`);
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

  const expectedFromBalance = Math.round((fromAccount.balance - amt) * 100) / 100;
  const expectedToBalance   = Math.round((toAccount.balance   + amt) * 100) / 100;
  const successResponse = ok({
    fromAccount: { ...fromAccount, balance: expectedFromBalance },
    toAccount:   { ...toAccount,   balance: expectedToBalance   },
  });

  return runWithIdempotency(
    extractIdempotencyKey(event),

    () => [
      {
        Update: {
          TableName: TABLES.accounts,
          Key: { accountId: fromAccountId },
          UpdateExpression: "SET balance = balance - :amt",
          // Atomically: source account still OPEN AND has sufficient funds
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
          // Atomically: destination account still OPEN
          ConditionExpression: "#status = :open",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":amt": amt, ":open": "OPEN" },
        },
      },
    ],

    // Verify via the source account — if its balance dropped by `amt`,
    // the whole atomic transaction ran (both sides moved).
    {
      verifyAccountId:       fromAccountId,
      verifyExpectedBalance: expectedFromBalance,
      recoveryStatusCode:    successResponse.statusCode,
      recoveryBody:          successResponse.body,
    },

    () => successResponse
  );
}

module.exports = { deposit, withdraw, transfer };
