"use strict";

/**
 * Idempotency helper — race-safe + crash-safe using atomic DynamoDB transactions.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  PROBLEMS SOLVED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  Problem 1 — Race condition (two simultaneous requests pass checkIdempotency)
 *  ─────────────────────────────────────────────────────────────────────────
 *  SOLVED: The idempotency Put and the balance Update are bundled in a single
 *  TransactWriteCommand.  DynamoDB executes it as one atomic unit.  Even if
 *  both requests see NOT_FOUND and proceed to build the transaction, only ONE
 *  transaction can win.  The other gets TransactionCanceledException with
 *  CancellationReasons[0].Code = "ConditionalCheckFailed" (idempotency Put
 *  rejected), and the balance Update is also cancelled — zero double-charge.
 *
 *  Problem 2 — attribute_not_exists only protects the idempotency record
 *  ─────────────────────────────────────────────────────────────────────────
 *  SOLVED: Same as above.  In a TransactWriteCommand ALL items succeed or ALL
 *  fail.  The condition on item[0] (idempotency Put) covers the whole
 *  transaction including item[1] (balance Update).
 *
 *  Problem 3 — Lambda crash after TransactWrite but before resolveIdempotency
 *  ─────────────────────────────────────────────────────────────────────────
 *  SOLVED HERE: We store recovery metadata inside the PROCESSING record at
 *  claim time:
 *    • verifyAccountId      — which account to read after a suspected crash
 *    • verifyExpectedBalance — the balance that proves the transaction ran
 *    • recoveryStatusCode   — the HTTP status code to replay
 *    • recoveryBody         — the JSON response body to replay
 *
 *  After waitForResolution() times out it enters crash-recovery mode:
 *    1. Re-read the PROCESSING record and inspect claimedAt.
 *    2. If the record is old enough (> CRASH_THRESHOLD_MS) assume the winner
 *       crashed rather than still being in-flight.
 *    3. Fetch the account from DynamoDB.
 *    4. If balance matches verifyExpectedBalance → transaction DID go through
 *       → self-resolve the record to DONE and return the stored response.
 *    5. If balance does NOT match → transaction never ran → return null so the
 *       caller returns 409 and the client retries without double-charging.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  TABLE SCHEMA  (Idempotency)
 * ═══════════════════════════════════════════════════════════════════════════
 *  PK  idempotencyKey        (S)
 *      status                (S)   "PROCESSING" | "DONE"
 *      claimedAt             (N)   epoch-ms; set when PROCESSING is written
 *      statusCode            (N)   HTTP status (only when DONE)
 *      body                  (S)   JSON response body (only when DONE)
 *      verifyAccountId       (S)   account to read during crash recovery
 *      verifyExpectedBalance (N)   expected balance after the operation
 *      recoveryStatusCode    (N)   HTTP status to replay on self-heal
 *      recoveryBody          (S)   JSON body to replay on self-heal
 *      ttl                   (N)   Unix epoch seconds (DynamoDB TTL)
 */

const { docClient, TABLES } = require("./dynamodb");
const { GetCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");

const TTL_SECONDS        = 24 * 60 * 60; // 24 hours — DynamoDB auto-expires entries
const RESOLVE_POLL_MS    = 100;           // how often to poll while waiting for DONE
const RESOLVE_TIMEOUT_MS = 3_000;         // max wait before entering crash-recovery
const CRASH_THRESHOLD_MS = 10_000;        // PROCESSING records older than this → assumed crashed

const DEFAULT_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: buildIdempotencyClaimItem
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the idempotency Put item to embed as the FIRST item of a
 * TransactWriteCommand alongside the business-logic Update items.
 *
 * @param {string} key - Idempotency-Key from the request header
 * @param {object} recovery - Crash-recovery metadata:
 *   @param {string} recovery.verifyAccountId       - account to read on crash recovery
 *   @param {number} recovery.verifyExpectedBalance - balance that proves the tx ran
 *   @param {number} recovery.recoveryStatusCode    - HTTP status to replay
 *   @param {string} recovery.recoveryBody          - JSON response body to replay
 */
function buildIdempotencyClaimItem(key, recovery) {
  const ttl = Math.floor(Date.now() / 1000) + TTL_SECONDS;

  return {
    TableName: TABLES.idempotency,
    Item: {
      idempotencyKey: key,
      status: "PROCESSING",
      claimedAt: Date.now(),
      // ── crash-recovery fields ───────────────────────────────────────────
      verifyAccountId: recovery.verifyAccountId,
      verifyExpectedBalance: recovery.verifyExpectedBalance,
      recoveryStatusCode: recovery.recoveryStatusCode,
      recoveryBody: recovery.recoveryBody,
      // ───────────────────────────────────────────────────────────────────
      ttl,
    },
    // Only ONE request can write this. If two race here, only one wins.
    // Because this Put is part of a TransactWrite, the balance Update in the
    // same transaction is also cancelled for the loser — zero double-charge.
    ConditionExpression: "attribute_not_exists(idempotencyKey)",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: resolveIdempotency
// ─────────────────────────────────────────────────────────────────────────────

/**
 * After a successful transaction, promote PROCESSING → DONE and store the
 * HTTP response so future retries get the cached answer.
 *
 * Uses a ConditionExpression so only the winner (who wrote PROCESSING) can
 * resolve — guards against a stale TTL-expired record being re-created.
 */
async function resolveIdempotency(key, response) {
  await docClient.send(
    new UpdateCommand({
      TableName: TABLES.idempotency,
      Key: { idempotencyKey: key },
      UpdateExpression:
        "SET #s = :done, statusCode = :code, #b = :body " +
        "REMOVE verifyAccountId, verifyExpectedBalance, recoveryStatusCode, recoveryBody, claimedAt",
      ConditionExpression: "#s = :processing",
      ExpressionAttributeNames: { "#s": "status", "#b": "body" },
      ExpressionAttributeValues: {
        ":done":       "DONE",
        ":processing": "PROCESSING",
        ":code":       response.statusCode,
        ":body":       response.body,
      },
    })
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: checkIdempotency
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reads the idempotency record and returns its state.
 *
 * Returns one of:
 *   { state: "DONE",       response }  — return this response immediately (safe replay)
 *   { state: "PROCESSING", record   }  — another request is in flight; caller should wait
 *   { state: "NOT_FOUND"            }  — first time seeing this key; proceed normally
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

  // PROCESSING — return the full record so waitForResolution can use
  // the crash-recovery fields without a second read.
  return { state: "PROCESSING", record: result.Item };
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: waitForResolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Polls the idempotency table until DONE or timeout, then attempts
 * crash-recovery if the record is old enough to assume the winner crashed.
 *
 * Returns the HTTP response object to return, or null if unresolvable
 * (caller returns 409 and tells client to use a new key).
 */
async function waitForResolution(key) {
  const deadline = Date.now() + RESOLVE_TIMEOUT_MS;
  let lastRecord = null;

  while (Date.now() < deadline) {
    await getSleep()(RESOLVE_POLL_MS);

    const check = await checkIdempotency(key);

    if (check.state === "DONE") {
      return check.response; // ← winner resolved normally, return cached response
    }

    if (check.state === "NOT_FOUND") {
      // Record was TTL-expired between the transaction and now — extremely rare.
      // Cannot recover safely; tell client to retry with a new key.
      return null;
    }

    // Still PROCESSING — keep polling; save the record for crash-recovery below.
    lastRecord = check.record;
  }

  // ── TIMEOUT — enter crash-recovery ────────────────────────────────────────
  //
  // Two possibilities:
  //   A) The winner Lambda is still running (slow cold start, heavy workload).
  //   B) The winner Lambda crashed after TransactWrite but before resolveIdempotency.
  //
  // We distinguish them by claimedAt age:
  //   • Young record (< CRASH_THRESHOLD_MS) → still in-flight → cannot safely recover.
  //   • Old record   (≥ CRASH_THRESHOLD_MS) → assumed crashed → try to self-heal.

  if (!lastRecord) return null; // No record available to recover from

  const age = Date.now() - (lastRecord.claimedAt ?? 0);
  if (age < CRASH_THRESHOLD_MS) {
    // Too young to call a crash — tell client to retry with a new key for now.
    console.warn(`Idempotency key '${key}' is PROCESSING but only ${age}ms old — not assuming crash yet`);
    return null;
  }

  // ── Crash confirmed — attempt self-heal ───────────────────────────────────
  //
  // Read the account balance.  If it matches verifyExpectedBalance, the
  // transaction DID go through before the crash.  Self-resolve and replay.
  // If it doesn't match, the transaction never ran — safe to let the client retry.

  console.warn(`Idempotency key '${key}' has been PROCESSING for ${age}ms — attempting crash recovery`);

  const { verifyAccountId, verifyExpectedBalance, recoveryStatusCode, recoveryBody } = lastRecord;

  if (!verifyAccountId || verifyExpectedBalance === undefined) {
    // No recovery metadata — cannot self-heal
    return null;
  }

  let currentAccount;
  try {
    const result = await docClient.send(
      new GetCommand({
        TableName: TABLES.accounts,
        Key: { accountId: verifyAccountId },
      })
    );
    currentAccount = result.Item;
  } catch (err) {
    console.error("Crash recovery: failed to fetch account for verification:", err);
    return null;
  }

  if (!currentAccount || currentAccount.balance !== verifyExpectedBalance) {
    // Balance does NOT match → transaction never ran → safe retry with new key
    console.warn(`Crash recovery: balance mismatch for '${verifyAccountId}' — transaction did not run`);
    return null;
  }

  // Balance matches → transaction DID run → self-resolve the stuck PROCESSING record
  console.warn(`Crash recovery: balance matches for '${verifyAccountId}' — self-resolving idempotency record`);

  const recoveredResponse = {
    statusCode: recoveryStatusCode,
    headers: DEFAULT_HEADERS,
    body: recoveryBody,
  };

  try {
    await resolveIdempotency(key, recoveredResponse);
  } catch (err) {
    // ConditionalCheckFailedException = another recovery already resolved it. Fine.
    if (err.name !== "ConditionalCheckFailedException") {
      console.error("Crash recovery: failed to resolve idempotency record:", err);
    }
  }

  return recoveredResponse;
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL
// ─────────────────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Use module.exports reference so tests can replace _sleep with a no-op
function getSleep() {
  return module.exports._sleep;
}

module.exports = {
  buildIdempotencyClaimItem,
  resolveIdempotency,
  checkIdempotency,
  waitForResolution,
  _sleep: sleep, // exported for testing only — allows tests to mock sleep to no-op
};
