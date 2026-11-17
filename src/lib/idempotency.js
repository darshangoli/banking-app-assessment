"use strict";

/**
 * Idempotency helper — race-condition-safe using a two-phase DynamoDB approach.
 *
 * WHY THE SIMPLE CHECK-THEN-WRITE APPROACH IS BROKEN
 * ---------------------------------------------------
 * A naive flow of:
 *   1. GET idempotency key  → not found
 *   2. UPDATE account balance
 *   3. PUT idempotency record
 * …has a gap between steps 1 and 2.  Two simultaneous retries can BOTH pass
 * step 1, BOTH run step 2, and double-charge the account.  The conditional
 * PUT in step 3 only protects the record write, not the balance update.
 *
 * THE CORRECT APPROACH — TWO PHASES
 * -----------------------------------
 * Phase 1 — CLAIM:
 *   The caller builds a TransactWriteCommand that atomically bundles:
 *     (a) Put  → Idempotency table  { status: "PROCESSING" }
 *               ConditionExpression: attribute_not_exists(idempotencyKey)
 *     (b) <the actual business operation — balance update, etc.>
 *
 *   DynamoDB guarantees: either BOTH succeed or NEITHER does.
 *   If two requests race, only ONE wins the transaction.  The loser gets
 *   TransactionCanceledException (reason[0] = ConditionalCheckFailed on the
 *   idempotency key) and must wait for the winner's response.
 *
 * Phase 2 — RESOLVE:
 *   After the transaction succeeds, the winner updates its idempotency record
 *   from status "PROCESSING" → "DONE" and stores the HTTP response body.
 *   Future retries that arrive after DONE is written get the cached response.
 *
 * LOSER HANDLING
 * --------------
 * When a request loses the race (TransactionCanceled on the idempotency key),
 * it retries reading the record for up to RESOLVE_TIMEOUT_MS.  Once the winner
 * writes DONE, the loser returns the same cached response.  If the winner
 * crashes before resolving, the loser eventually returns 409 CONFLICT advising
 * the client to retry with a new key.
 *
 * Table schema:
 *   PK  idempotencyKey  (S)
 *       status          (S)  — "PROCESSING" | "DONE"
 *       statusCode      (N)  — HTTP status (only when DONE)
 *       body            (S)  — JSON response body (only when DONE)
 *       ttl             (N)  — Unix epoch seconds (DynamoDB TTL)
 */

const { docClient, TABLES } = require("./dynamodb");
const { GetCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");

const TTL_SECONDS = 24 * 60 * 60; // 24 hours
const RESOLVE_POLL_MS = 100;       // poll interval while waiting for DONE
const RESOLVE_TIMEOUT_MS = 3000;   // max wait for a PROCESSING key to resolve

const DEFAULT_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

/**
 * Returns the idempotency Put item to embed inside a TransactWriteCommand.
 *
 * Usage — include this as one of the TransactItems:
 *   {
 *     Put: buildIdempotencyClaimItem(key)
 *   }
 *
 * The ConditionExpression ensures only ONE transaction wins when two requests
 * race with the same key.
 */
function buildIdempotencyClaimItem(key) {
  const ttl = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  return {
    TableName: TABLES.idempotency,
    Item: {
      idempotencyKey: key,
      status: "PROCESSING",
      ttl,
    },
    // If the key already exists (PROCESSING or DONE), reject this transaction.
    ConditionExpression: "attribute_not_exists(idempotencyKey)",
  };
}

/**
 * After a successful transaction, promote the idempotency record from
 * PROCESSING → DONE and store the HTTP response body.
 *
 * Uses a ConditionExpression so only the winner (who wrote PROCESSING) can
 * resolve — guards against a stale TTL-expired record being re-created by
 * a very late retry.
 */
async function resolveIdempotency(key, response) {
  await docClient.send(
    new UpdateCommand({
      TableName: TABLES.idempotency,
      Key: { idempotencyKey: key },
      UpdateExpression: "SET #s = :done, statusCode = :code, body = :body",
      ConditionExpression: "#s = :processing",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":done": "DONE",
        ":processing": "PROCESSING",
        ":code": response.statusCode,
        ":body": response.body,
      },
    })
  );
}

/**
 * Checks whether an idempotency key already has a stored result.
 *
 * Returns:
 *   { state: "DONE",       response }   — return this response immediately
 *   { state: "PROCESSING"           }   — another request is in flight; caller should wait
 *   { state: "NOT_FOUND"            }   — first time seeing this key; proceed normally
 */
async function checkIdempotency(key) {
  const result = await docClient.send(
    new GetCommand({
      TableName: TABLES.idempotency,
      Key: { idempotencyKey: key },
    })
  );

  if (!result.Item) return { state: "NOT_FOUND" };

  if (result.Item.status === "DONE") {
    return {
      state: "DONE",
      response: {
        statusCode: result.Item.statusCode,
        headers: DEFAULT_HEADERS,
        body: result.Item.body,
      },
    };
  }

  return { state: "PROCESSING" };
}

/**
 * Polls the idempotency table until the key transitions to DONE or the
 * timeout is reached.  Used by the "loser" of a transaction race.
 *
 * Returns the cached response, or null if it never resolved in time.
 */
async function waitForResolution(key) {
  const deadline = Date.now() + RESOLVE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, RESOLVE_POLL_MS));
    const check = await checkIdempotency(key);
    if (check.state === "DONE") return check.response;
  }
  return null; // Timed out — winner may have crashed
}

module.exports = {
  buildIdempotencyClaimItem,
  resolveIdempotency,
  checkIdempotency,
  waitForResolution,
};
