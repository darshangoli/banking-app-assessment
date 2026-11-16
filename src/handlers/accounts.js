"use strict";

const { ok, created, badRequest, notFound, serverError, parseJsonBody } = require("../lib/response");
const { docClient, TABLES } = require("../lib/dynamodb");
const { GetCommand, PutCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");
const { v4: uuidv4 } = require("uuid");

const VALID_TYPES = new Set(["CHECKING", "SAVINGS"]);
const VALID_CURRENCIES = new Set(["CAD", "USD"]);

/**
 * POST /customers/{customerId}/accounts
 *
 * Validates that the customer exists, then creates an account with the given
 * type and currency. initialBalance defaults to 0 and must be >= 0.
 * Returns 201 with the created Account, or 404 if the customer is not found.
 */
async function create(event) {
  const customerId = event.pathParameters?.customerId;
  if (!customerId) {
    return badRequest("customerId path parameter is required");
  }

  const parsed = parseJsonBody(event);
  if (!parsed.ok) {
    return parsed.response;
  }

  const { type, currency, initialBalance = 0 } = parsed.data;

  if (!type || !VALID_TYPES.has(type)) {
    return badRequest(`type must be one of: ${[...VALID_TYPES].join(", ")}`);
  }

  if (!currency || !VALID_CURRENCIES.has(currency)) {
    return badRequest(`currency must be one of: ${[...VALID_CURRENCIES].join(", ")}`);
  }

  const balance = Number(initialBalance);
  if (isNaN(balance) || balance < 0) {
    return badRequest("initialBalance must be a number >= 0");
  }

  try {
    const customerResult = await docClient.send(
      new GetCommand({
        TableName: TABLES.customers,
        Key: { customerId },
      })
    );

    if (!customerResult.Item) {
      return notFound(`Customer '${customerId}' not found`);
    }
  } catch (err) {
    console.error("DynamoDB GetCommand failed (customers in account create):", err);
    return serverError("Failed to verify customer");
  }

  const account = {
    accountId: `acct_${uuidv4().replace(/-/g, "").slice(0, 12)}`,
    customerId,
    type,
    currency,
    balance,
    status: "OPEN",
    createdAt: new Date().toISOString(),
  };

  try {
    await docClient.send(
      new PutCommand({
        TableName: TABLES.accounts,
        Item: account,
      })
    );
  } catch (err) {
    console.error("DynamoDB PutCommand failed (accounts):", err);
    return serverError("Failed to create account");
  }

  return created(account);
}

/**
 * GET /customers/{customerId}/accounts
 *
 * Lists all accounts for a customer using a Query on the CustomerIdIndex GSI
 * (avoids a full table Scan). Returns 404 if the customer does not exist.
 */
async function list(event) {
  const customerId = event.pathParameters?.customerId;
  if (!customerId) {
    return badRequest("customerId path parameter is required");
  }

  try {
    const customerResult = await docClient.send(
      new GetCommand({
        TableName: TABLES.customers,
        Key: { customerId },
      })
    );

    if (!customerResult.Item) {
      return notFound(`Customer '${customerId}' not found`);
    }
  } catch (err) {
    console.error("DynamoDB GetCommand failed (customers in account list):", err);
    return serverError("Failed to verify customer");
  }

  try {
    const result = await docClient.send(
      new QueryCommand({
        TableName: TABLES.accounts,
        IndexName: "CustomerIdIndex",
        KeyConditionExpression: "customerId = :customerId",
        ExpressionAttributeValues: {
          ":customerId": customerId,
        },
      })
    );

    return ok({ items: result.Items ?? [] });
  } catch (err) {
    console.error("DynamoDB QueryCommand failed (accounts GSI):", err);
    return serverError("Failed to list accounts");
  }
}

/**
 * GET /accounts/{accountId}
 *
 * Fetches a single account by accountId (includes balance).
 * Returns 200 with Account, or 404 if not found.
 */
async function get(event) {
  const accountId = event.pathParameters?.accountId;
  if (!accountId) {
    return badRequest("accountId path parameter is required");
  }

  try {
    const result = await docClient.send(
      new GetCommand({
        TableName: TABLES.accounts,
        Key: { accountId },
      })
    );

    if (!result.Item) {
      return notFound(`Account '${accountId}' not found`);
    }

    return ok(result.Item);
  } catch (err) {
    console.error("DynamoDB GetCommand failed (accounts):", err);
    return serverError("Failed to fetch account");
  }
}

module.exports = {
  create,
  list,
  get,
};
