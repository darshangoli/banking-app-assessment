"use strict";

const { ok, badRequest, notFound, conflict, serverError, parseJsonBody } = require("../lib/response");
const { docClient, TABLES } = require("../lib/dynamodb");
const { GetCommand, UpdateCommand, TransactWriteCommand } = require("@aws-sdk/lib-dynamodb");

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
 * POST /accounts/{accountId}/deposits
 *
 * Credits the account balance.
 * - amount must be > 0
 * - currency must match the account's currency
 * - Uses a DynamoDB UpdateExpression with an atomic ADD to avoid lost-update races
 * - Returns 200 with the updated Account
 */
async function deposit(event) {
  const accountId = event.pathParameters?.accountId;
  if (!accountId) {
    return badRequest("accountId path parameter is required");
  }

  const parsed = parseJsonBody(event);
  if (!parsed.ok) {
    return parsed.response;
  }

  const { amount, currency } = parsed.data;

  if (!currency || !VALID_CURRENCIES.has(currency)) {
    return badRequest(`currency must be one of: ${[...VALID_CURRENCIES].join(", ")}`);
  }

  const amt = Number(amount);
  if (isNaN(amt) || amt <= 0) {
    return badRequest("amount must be a number greater than 0");
  }

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
        ExpressionAttributeValues: { ":amt": amt },
        ReturnValues: "ALL_NEW",
      })
    );
    return ok(result.Attributes);
  } catch (err) {
    console.error("DynamoDB UpdateCommand failed (deposit):", err);
    return serverError("Failed to apply deposit");
  }
}

/**
 * POST /accounts/{accountId}/withdrawals
 *
 * Debits the account balance.
 * - amount must be > 0
 * - currency must match the account's currency
 * - Returns 409 CONFLICT if balance would go below 0 (insufficient funds)
 * - Uses a ConditionExpression so the check and decrement are atomic
 * - Returns 200 with the updated Account
 */
async function withdraw(event) {
  const accountId = event.pathParameters?.accountId;
  if (!accountId) {
    return badRequest("accountId path parameter is required");
  }

  const parsed = parseJsonBody(event);
  if (!parsed.ok) {
    return parsed.response;
  }

  const { amount, currency } = parsed.data;

  if (!currency || !VALID_CURRENCIES.has(currency)) {
    return badRequest(`currency must be one of: ${[...VALID_CURRENCIES].join(", ")}`);
  }

  const amt = Number(amount);
  if (isNaN(amt) || amt <= 0) {
    return badRequest("amount must be a number greater than 0");
  }

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
        ConditionExpression: "balance >= :amt",
        ExpressionAttributeValues: { ":amt": amt },
        ReturnValues: "ALL_NEW",
      })
    );
    return ok(result.Attributes);
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      return conflict("Insufficient funds");
    }
    console.error("DynamoDB UpdateCommand failed (withdraw):", err);
    return serverError("Failed to apply withdrawal");
  }
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
 * (balance >= amount) so insufficient funds abort the whole transaction
 * before any money moves.  This satisfies atomicity without any
 * application-level compensating transactions or retry loops.
 * ------------------------------------------------------------------
 *
 * Returns 200: { fromAccount, toAccount }
 */
async function transfer(event) {
  const parsed = parseJsonBody(event);
  if (!parsed.ok) {
    return parsed.response;
  }

  const { fromAccountId, toAccountId, amount, currency } = parsed.data;

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

  const amt = Number(amount);
  if (isNaN(amt) || amt <= 0) {
    return badRequest("amount must be a number greater than 0");
  }

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
              ConditionExpression: "balance >= :amt",
              ExpressionAttributeValues: { ":amt": amt },
            },
          },
          {
            Update: {
              TableName: TABLES.accounts,
              Key: { accountId: toAccountId },
              UpdateExpression: "SET balance = balance + :amt",
              ExpressionAttributeValues: { ":amt": amt },
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
      return conflict("Insufficient funds in source account");
    }
    console.error("DynamoDB TransactWriteCommand failed (transfer):", err);
    return serverError("Failed to complete transfer");
  }

  try {
    [fromAccount, toAccount] = await Promise.all([
      fetchAccount(fromAccountId),
      fetchAccount(toAccountId),
    ]);
  } catch (err) {
    console.error("DynamoDB GetCommand failed (transfer post-fetch):", err);
    return serverError("Transfer completed but failed to fetch updated accounts");
  }

  return ok({ fromAccount, toAccount });
}

module.exports = {
  deposit,
  withdraw,
  transfer,
};
