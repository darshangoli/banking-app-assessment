"use strict";

/**
 * Idempotency helper for write APIs.
 *
 * How it works:
 *  1. On every write request the caller passes the value of the
 *     `Idempotency-Key` header (a UUID chosen by the client).
 *  2. `checkIdempotency(key)` looks it up in the Idempotency DynamoDB table.
 *     - If found  → return the cached HTTP response immediately (no DB write).
 *     - If not found → return null (caller proceeds normally).
 *  3. After the write succeeds, `saveIdempotency(key, response)` stores the
 *     result with a TTL of 24 hours so future retries get the same answer.
 *
 * Table schema:
 *   PK  idempotencyKey  (S)
 *       statusCode      (N)
 *       body            (S)  — JSON-stringified response body
 *       ttl             (N)  — Unix epoch seconds; DynamoDB TTL deletes after expiry
 */

const { docClient, TABLES } = require("./dynamodb");
const { GetCommand, PutCommand } = require("@aws-sdk/lib-dynamodb");

const TTL_SECONDS = 24 * 60 * 60; // 24 hours

/**
 * Looks up an idempotency key.
 * Returns the cached response object { statusCode, headers, body } or null.
 */
async function checkIdempotency(key) {
  const result = await docClient.send(
    new GetCommand({
      TableName: TABLES.idempotency,
      Key: { idempotencyKey: key },
    })
  );

  if (!result.Item) return null;

  return {
    statusCode: result.Item.statusCode,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    body: result.Item.body,
  };
}

/**
 * Persists the response for an idempotency key with a 24-hour TTL.
 * `response` is the full API Gateway response object { statusCode, headers, body }.
 */
async function saveIdempotency(key, response) {
  const ttl = Math.floor(Date.now() / 1000) + TTL_SECONDS;

  await docClient.send(
    new PutCommand({
      TableName: TABLES.idempotency,
      Item: {
        idempotencyKey: key,
        statusCode: response.statusCode,
        body: response.body,
        ttl,
      },
      // Only write if key does not already exist — prevents a race where two
      // simultaneous retries of the same key both reach this point.
      ConditionExpression: "attribute_not_exists(idempotencyKey)",
    })
  );
}

module.exports = { checkIdempotency, saveIdempotency };
