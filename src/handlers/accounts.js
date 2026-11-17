"use strict";

const { ok, created, badRequest, notFound, serverError, parseJsonBody } = require("../lib/response");
const { docClient, TABLES } = require("../lib/dynamodb");
const { GetCommand, PutCommand, QueryCommand, ScanCommand } = require("@aws-sdk/lib-dynamodb");

const VALID_TYPES = new Set(["CHECKING", "SAVINGS"]);
const VALID_CURRENCIES = new Set(["CAD", "USD"]);

/**
 * Generates the next sequential accountId in the format acct_NNN.
 * Scans the table, finds the highest existing numeric suffix, and increments it.
 */
async function nextAccountId() {
  const result = await docClient.send(
    new ScanCommand({
      TableName: TABLES.accounts,
      ProjectionExpression: "accountId",
    })
  );
  let max = 0;
  for (const item of result.Items ?? []) {
    const match = item.accountId?.match(/^acct_(\d+)$/);
    if (match) {
      const n = parseInt(match[1], 10);
      if (n > max) max = n;
    }
  }
  return `acct_${String(max + 1).padStart(3, "0")}`;
}

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

  let accountId;
  try {
    accountId = await nextAccountId();
  } catch (err) {
    console.error("Failed to generate accountId:", err);
    return serverError("Failed to generate account ID");
  }

  const account = {
    accountId,
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
 * Lists accounts for a customer using a Query on the CustomerIdIndex GSI.
 * Supports cursor-based pagination via `limit` and `nextToken` query params.
 *
 * Query parameters:
 *   limit     — max items to return per page (default 20, max 100)
 *   nextToken — opaque base64 cursor returned from a previous response
 *
 * Returns 404 if the customer does not exist.
 * Returns { items, nextToken } where nextToken is null on the last page.
 */
async function list(event) {
  const customerId = event.pathParameters?.customerId;
  if (!customerId) {
    return badRequest("customerId path parameter is required");
  }

  // Parse and clamp limit
  const rawLimit = parseInt(event.queryStringParameters?.limit, 10);
  const limit = isNaN(rawLimit) || rawLimit <= 0 ? 20 : Math.min(rawLimit, 100);

  // Decode the nextToken cursor (base64-encoded JSON of DynamoDB's LastEvaluatedKey)
  let exclusiveStartKey;
  const rawToken = event.queryStringParameters?.nextToken;
  if (rawToken) {
    try {
      exclusiveStartKey = JSON.parse(Buffer.from(rawToken, "base64").toString("utf8"));
    } catch {
      return badRequest("nextToken is invalid or corrupted");
    }
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
        Limit: limit,
        ExclusiveStartKey: exclusiveStartKey,
      })
    );

    // Encode the next page cursor, or null if this is the last page
    const nextToken = result.LastEvaluatedKey
      ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString("base64")
      : null;

    return ok({ items: result.Items ?? [], nextToken });
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
