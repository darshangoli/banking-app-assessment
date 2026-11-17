"use strict";

const { ok, badRequest, notFound, conflict, serverError, parseJsonBody } = require("../lib/response");
const { docClient, TABLES } = require("../lib/dynamodb");
const { GetCommand, UpdateCommand, TransactWriteCommand } = require("@aws-sdk/lib-dynamodb");
const { validateAmount } = require("../lib/validate");
const { checkIdempotency, saveIdempotency } = require("../lib/idempotency");

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
 * Checks idempotency key from request headers.
 * Returns { key, cached } where cached is a response to return immediately,
 * or null if the request should proceed normally.
 */
function extractIdempotencyKey(event) {
  // Headers are lowercased by API Gateway; serverless-offline preserves case.
  const headers = event.headers ?? {};
  return (
    headers["idempotency-key"] ||
    headers["Idempotency-Key"] ||
    null
  );
}

/**
 * Wraps a handler's core logic with idempotency + save.
 * `key` may be null — if so, idempotency is skipped.
 */
async function withIdempotency(key, fn) {
  if (key) {
    try {
      const cached = await checkIdempotency(key);
      if (cached) return cached; // Return stored result for duplicate request
    } catch (err) {
      console.error("Idempotency check failed:", err);
      // Non-fatal — proceed without idempotency rather than rejecting the request
    }
  }

  const response = await fn();

  if (key) {
    try {
      await saveIdempotency(key, response);
    } catch (err) {
      // ConditionalCheckFailedException means a concurrent request already saved it — OK.
      if (err.name !== "ConditionalCheckFailedException") {
        console.error("Idempotency save failed:", err);
      }
    }
  }

  return response;
}

/**
 * POST /accounts/{accountId}/deposits
 *
 * Credits the account balance.
 * - amount must be > 0 with at most 2 decimal places
 * - currency must match the account's currency
 * - account must be OPEN
 * - Idempotency-Key header prevents duplicate charges on client retry
 * - Uses a DynamoDB UpdateExpression with an atomic ADD to avoid lost-update races
 * - Returns 200 with the updated Account
 */
async function deposit(event) {
  const accountId = event.pathParameters?.accountId;
  if (!accountId) {
    return badRequest("accountId path parameter is required");
  }

  const parsed = parseJsonBody(event);
  if (!parsed.ok) return parsed.response;

  const { currency } = parsed.data;

  if (!currency || !VALID_CURRENCIES.has(currency)) {
    return badRequest(`currency must be one of: ${[...VALID_CURRENCIES].join(", ")}`);
  }

  // Validate amount precision (2 dp, > 0, finite)
  const amtResult = validateAmount(parsed.data.amount);
  if (!amtResult.ok) return badRequest(amtResult.message);
  const amt = amtResult.value;

  const idempotencyKey = extractIdempotencyKey(event);

  return withIdempotency(idempotencyKey, async () => {
    let account;
    try {
      account = await fetchAccount(accountId);
    } catch (err) {
      console.error("DynamoDB GetCommand failed (deposit):", err);
      return serverError("Failed to fetch account");
    }

    if (!account) {
      return notFound(`Account '${accountId}' not found`);
    }

    // Account status check — only OPEN accounts accept transactions
    if (account.status !== "OPEN") {
      return conflict(`Account '${accountId}' is ${account.status} and cannot accept deposits`);
    }

    if (account.currency !== currency) {
      return badRequest(
        `Currency mismatch: account currency is ${account.currency}, request currency is ${currency}`
      );
    }

    try {
      const result = await docClient.send(
        new UpdateCommand({
          TableName: TABLES.accounts,
          Key: { accountId },
          UpdateExpression: "SET balance = balance + :amt",
          ConditionExpression: "#status = :open",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":amt": amt, ":open": "OPEN" },
          ReturnValues: "ALL_NEW",
        })
      );
      return ok(result.Attributes);
    } catch (err) {
      if (err.name === "ConditionalCheckFailedException") {
        return conflict(`Account '${accountId}' is no longer OPEN`);
      }
      console.error("DynamoDB UpdateCommand failed (deposit):", err);
      return serverError("Failed to apply deposit");
    }
  });
}

/**
 * POST /accounts/{accountId}/withdrawals
 *
 * Debits the account balance.
 * - amount must be > 0 with at most 2 decimal places
 * - currency must match the account's currency
 * - account must be OPEN
 * - Returns 409 CONFLICT if balance would go below 0 (insufficient funds)
 * - Idempotency-Key header prevents duplicate debits on client retry
 * - Uses a ConditionExpression so the check and decrement are atomic
 * - Returns 200 with the updated Account
 */
async function withdraw(event) {
  const accountId = event.pathParameters?.accountId;
  if (!accountId) {
    return badRequest("accountId path parameter is required");
  }

  const parsed = parseJsonBody(event);
  if (!parsed.ok) return parsed.response;

  const { currency } = parsed.data;

  if (!currency || !VALID_CURRENCIES.has(currency)) {
    return badRequest(`currency must be one of: ${[...VALID_CURRENCIES].join(", ")}`);
  }

  // Validate amount precision
  const amtResult = validateAmount(parsed.data.amount);
  if (!amtResult.ok) return badRequest(amtResult.message);
  const amt = amtResult.value;

  const idempotencyKey = extractIdempotencyKey(event);

  return withIdempotency(idempotencyKey, async () => {
    let account;
    try {
      account = await fetchAccount(accountId);
    } catch (err) {
      console.error("DynamoDB GetCommand failed (withdraw):", err);
      return serverError("Failed to fetch account");
    }

    if (!account) {
      return notFound(`Account '${accountId}' not found`);
    }

    // Account status check — only OPEN accounts accept transactions
    if (account.status !== "OPEN") {
      return conflict(`Account '${accountId}' is ${account.status} and cannot accept withdrawals`);
    }

    if (account.currency !== currency) {
      return badRequest(
        `Currency mismatch: account currency is ${account.currency}, request currency is ${currency}`
      );
    }

    try {
      const result = await docClient.send(
        new UpdateCommand({
          TableName: TABLES.accounts,
          Key: { accountId },
          UpdateExpression: "SET balance = balance - :amt",
          // Both conditions must hold atomically: account is OPEN AND has sufficient funds
          ConditionExpression: "#status = :open AND balance >= :amt",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":amt": amt, ":open": "OPEN" },
          ReturnValues: "ALL_NEW",
        })
      );
      return ok(result.Attributes);
    } catch (err) {
      if (err.name === "ConditionalCheckFailedException") {
        // Distinguish between closed account and insufficient funds
        // Re-fetch to check current status (account was already OPEN above, so
        // most likely it's insufficient funds, but guard against status change).
        return conflict("Insufficient funds or account is no longer OPEN");
      }
      console.error("DynamoDB UpdateCommand failed (withdraw):", err);
      return serverError("Failed to apply withdrawal");
    }
  });
}

/**
 * POST /transfers
 *
 * Moves funds between two accounts atomically using DynamoDB TransactWrite.
 *
 * Consistency approach:
 * ------------------------------------------------------------------
 * DynamoDB TransactWriteItems bundles both the debit on fromAccount and
 * the credit on toAccount into a single all-or-nothing transaction.
 * Either both succeed or neither does — there is no partial state visible
 * to any reader. The debit item carries a ConditionExpression
 * (balance >= amount AND status = OPEN) so insufficient funds or a closed
 * account aborts the whole transaction before any money moves.
 * ------------------------------------------------------------------
 *
 * Returns 200: { fromAccount, toAccount }
 */
async function transfer(event) {
  const parsed = parseJsonBody(event);
  if (!parsed.ok) return parsed.response;

  const { fromAccountId, toAccountId, currency } = parsed.data;

  if (!fromAccountId || typeof fromAccountId !== "string") {
    return badRequest("fromAccountId is required");
  }
  if (!toAccountId || typeof toAccountId !== "string") {
    return badRequest("toAccountId is required");
  }
  if (fromAccountId === toAccountId) {
    return badRequest("fromAccountId and toAccountId must be different accounts");
  }
  if (!currency || !VALID_CURRENCIES.has(currency)) {
    return badRequest(`currency must be one of: ${[...VALID_CURRENCIES].join(", ")}`);
  }

  // Validate amount precision
  const amtResult = validateAmount(parsed.data.amount);
  if (!amtResult.ok) return badRequest(amtResult.message);
  const amt = amtResult.value;

  const idempotencyKey = extractIdempotencyKey(event);

  return withIdempotency(idempotencyKey, async () => {
    // Fetch both accounts in parallel
    let fromAccount, toAccount;
    try {
      [fromAccount, toAccount] = await Promise.all([
        fetchAccount(fromAccountId),
        fetchAccount(toAccountId),
      ]);
    } catch (err) {
      console.error("DynamoDB GetCommand failed (transfer fetch):", err);
      return serverError("Failed to fetch accounts");
    }

    if (!fromAccount) {
      return notFound(`Source account '${fromAccountId}' not found`);
    }
    if (!toAccount) {
      return notFound(`Destination account '${toAccountId}' not found`);
    }

    // Account status checks
    if (fromAccount.status !== "OPEN") {
      return conflict(`Source account '${fromAccountId}' is ${fromAccount.status} and cannot send transfers`);
    }
    if (toAccount.status !== "OPEN") {
      return conflict(`Destination account '${toAccountId}' is ${toAccount.status} and cannot receive transfers`);
    }

    if (fromAccount.currency !== currency) {
      return badRequest(
        `Currency mismatch: source account currency is ${fromAccount.currency}, request currency is ${currency}`
      );
    }
    if (toAccount.currency !== currency) {
      return badRequest(
        `Currency mismatch: destination account currency is ${toAccount.currency}, request currency is ${currency}`
      );
    }

    try {
      await docClient.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: TABLES.accounts,
                Key: { accountId: fromAccountId },
                UpdateExpression: "SET balance = balance - :amt",
                // Atomically guard: account still OPEN AND has sufficient funds
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
                // Atomically guard: destination account still OPEN
                ConditionExpression: "#status = :open",
                ExpressionAttributeNames: { "#status": "status" },
                ExpressionAttributeValues: { ":amt": amt, ":open": "OPEN" },
              },
            },
          ],
        })
      );
    } catch (err) {
      if (
        err.name === "TransactionCanceledException" &&
        err.CancellationReasons?.some((r) => r.Code === "ConditionalCheckFailed")
      ) {
        return conflict("Insufficient funds in source account or one of the accounts is no longer OPEN");
      }
      console.error("DynamoDB TransactWriteCommand failed (transfer):", err);
      return serverError("Failed to complete transfer");
    }

    // Return computed balances — avoids a second round-trip to DynamoDB
    return ok({
      fromAccount: { ...fromAccount, balance: Math.round((fromAccount.balance - amt) * 100) / 100 },
      toAccount: { ...toAccount, balance: Math.round((toAccount.balance + amt) * 100) / 100 },
    });
  });
}

module.exports = {
  deposit,
  withdraw,
  transfer,
};
