"use strict";

/**
 * Tests for the idempotency system and all transaction handlers.
 *
 * Call order for deposit/withdraw WITH idempotency key:
 *   1. GET account (pre-check)
 *   2. GET Idempotency table (checkIdempotency)
 *   3. TransactWriteCommand  [idempotency Put + balance Update]
 *   4. UpdateCommand         (resolveIdempotency: PROCESSING → DONE)
 *
 * Call order WITHOUT idempotency key:
 *   1. GET account (pre-check)
 *   2. TransactWriteCommand  [balance Update only]
 */

// ─── Mock DynamoDB ────────────────────────────────────────────────────────────
jest.mock("../src/lib/dynamodb", () => ({
  docClient: { send: jest.fn() },
  TABLES: {
    customers:   "Customers",
    accounts:    "Accounts",
    idempotency: "Idempotency",
  },
}));

const { docClient } = require("../src/lib/dynamodb");
const { deposit, withdraw, transfer } = require("../src/handlers/transactions");
const idempotencyLib = require("../src/lib/idempotency");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEvent(overrides = {}) {
  return {
    pathParameters: null,
    queryStringParameters: null,
    headers: {},
    body: null,
    isBase64Encoded: false,
    ...overrides,
  };
}

function withKey(key, overrides = {}) {
  return makeEvent({ headers: { "Idempotency-Key": key }, ...overrides });
}

function jsonBody(obj) { return JSON.stringify(obj); }
function parseBody(res) { return JSON.parse(res.body); }

// A fully open account fixture
const OPEN_ACCOUNT = {
  accountId: "acct_001",
  customerId: "cust_001",
  type: "CHECKING",
  currency: "CAD",
  balance: 1000,
  status: "OPEN",
  createdAt: "2024-01-01T00:00:00Z",
};

const CLOSED_ACCOUNT = { ...OPEN_ACCOUNT, status: "CLOSED" };

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — Normal happy path (no idempotency key)
// Call order: GET account → TransactWrite
// ─────────────────────────────────────────────────────────────────────────────

describe("deposit — happy path (no idempotency key)", () => {
  beforeEach(() => docClient.send.mockReset());

  test("200 — deposits and returns updated balance", async () => {
    docClient.send
      .mockResolvedValueOnce({ Item: OPEN_ACCOUNT }) // [1] pre-check GET account
      .mockResolvedValueOnce({});                    // [2] TransactWriteCommand

    const res = await deposit(makeEvent({
      pathParameters: { accountId: "acct_001" },
      body: jsonBody({ amount: 50, currency: "CAD" }),
    }));

    expect(res.statusCode).toBe(200);
    expect(parseBody(res).balance).toBe(1050);
  });

  test("200 — amount with 2 decimal places is accepted", async () => {
    docClient.send
      .mockResolvedValueOnce({ Item: OPEN_ACCOUNT })
      .mockResolvedValueOnce({});

    const res = await deposit(makeEvent({
      pathParameters: { accountId: "acct_001" },
      body: jsonBody({ amount: 10.99, currency: "CAD" }),
    }));

    expect(res.statusCode).toBe(200);
    expect(parseBody(res).balance).toBe(1010.99);
  });
});

describe("withdraw — happy path (no idempotency key)", () => {
  beforeEach(() => docClient.send.mockReset());

  test("200 — withdraws and returns updated balance", async () => {
    docClient.send
      .mockResolvedValueOnce({ Item: OPEN_ACCOUNT }) // [1] pre-check GET
      .mockResolvedValueOnce({});                    // [2] TransactWrite

    const res = await withdraw(makeEvent({
      pathParameters: { accountId: "acct_001" },
      body: jsonBody({ amount: 200, currency: "CAD" }),
    }));

    expect(res.statusCode).toBe(200);
    expect(parseBody(res).balance).toBe(800);
  });
});

describe("transfer — happy path (no idempotency key)", () => {
  const TO_ACCOUNT = { ...OPEN_ACCOUNT, accountId: "acct_002", balance: 500 };

  beforeEach(() => docClient.send.mockReset());

  test("200 — transfers and returns both updated balances", async () => {
    docClient.send
      .mockResolvedValueOnce({ Item: OPEN_ACCOUNT }) // [1] fetchAccount(from)
      .mockResolvedValueOnce({ Item: TO_ACCOUNT })   // [2] fetchAccount(to)
      .mockResolvedValueOnce({});                    // [3] TransactWrite

    const res = await transfer(makeEvent({
      body: jsonBody({ fromAccountId: "acct_001", toAccountId: "acct_002", amount: 300, currency: "CAD" }),
    }));

    expect(res.statusCode).toBe(200);
    const body = parseBody(res);
    expect(body.fromAccount.balance).toBe(700);
    expect(body.toAccount.balance).toBe(800);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — Input validation
// ─────────────────────────────────────────────────────────────────────────────

describe("amount precision validation", () => {
  beforeEach(() => docClient.send.mockReset());

  test("400 — amount with 3 decimal places is rejected (before any DB call)", async () => {
    const res = await deposit(makeEvent({
      pathParameters: { accountId: "acct_001" },
      body: jsonBody({ amount: 10.001, currency: "CAD" }),
    }));
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).message).toMatch(/2 decimal/i);
    expect(docClient.send).not.toHaveBeenCalled();
  });

  test("400 — amount of zero is rejected", async () => {
    const res = await deposit(makeEvent({
      pathParameters: { accountId: "acct_001" },
      body: jsonBody({ amount: 0, currency: "CAD" }),
    }));
    expect(res.statusCode).toBe(400);
  });

  test("400 — negative amount is rejected", async () => {
    const res = await withdraw(makeEvent({
      pathParameters: { accountId: "acct_001" },
      body: jsonBody({ amount: -50, currency: "CAD" }),
    }));
    expect(res.statusCode).toBe(400);
  });

  test("400 — missing amount is rejected", async () => {
    const res = await deposit(makeEvent({
      pathParameters: { accountId: "acct_001" },
      body: jsonBody({ currency: "CAD" }),
    }));
    expect(res.statusCode).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — Account status checks
// ─────────────────────────────────────────────────────────────────────────────

describe("account status checks", () => {
  beforeEach(() => docClient.send.mockReset());

  test("409 — deposit into CLOSED account is rejected", async () => {
    docClient.send.mockResolvedValueOnce({ Item: CLOSED_ACCOUNT }); // [1] pre-check GET

    const res = await deposit(makeEvent({
      pathParameters: { accountId: "acct_001" },
      body: jsonBody({ amount: 100, currency: "CAD" }),
    }));
    expect(res.statusCode).toBe(409);
    expect(parseBody(res).message).toMatch(/CLOSED/);
    // No further DB calls — rejected before reaching the transaction
    expect(docClient.send).toHaveBeenCalledTimes(1);
  });

  test("409 — withdrawal from CLOSED account is rejected", async () => {
    docClient.send.mockResolvedValueOnce({ Item: CLOSED_ACCOUNT });

    const res = await withdraw(makeEvent({
      pathParameters: { accountId: "acct_001" },
      body: jsonBody({ amount: 100, currency: "CAD" }),
    }));
    expect(res.statusCode).toBe(409);
    expect(parseBody(res).message).toMatch(/CLOSED/);
  });

  test("409 — transfer from CLOSED source account is rejected", async () => {
    const TO_ACCOUNT = { ...OPEN_ACCOUNT, accountId: "acct_002" };
    docClient.send
      .mockResolvedValueOnce({ Item: CLOSED_ACCOUNT })
      .mockResolvedValueOnce({ Item: TO_ACCOUNT });

    const res = await transfer(makeEvent({
      body: jsonBody({ fromAccountId: "acct_001", toAccountId: "acct_002", amount: 50, currency: "CAD" }),
    }));
    expect(res.statusCode).toBe(409);
    expect(parseBody(res).message).toMatch(/CLOSED/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — Insufficient funds
// ─────────────────────────────────────────────────────────────────────────────

describe("insufficient funds", () => {
  beforeEach(() => docClient.send.mockReset());

  test("409 — withdraw more than balance triggers TransactionCanceledException", async () => {
    // No idempotency key → business item is at index 0
    const txError = Object.assign(new Error("Transaction cancelled"), {
      name: "TransactionCanceledException",
      CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
    });

    docClient.send
      .mockResolvedValueOnce({ Item: OPEN_ACCOUNT }) // [1] pre-check GET
      .mockRejectedValueOnce(txError);               // [2] TransactWrite fails

    const res = await withdraw(makeEvent({
      pathParameters: { accountId: "acct_001" },
      body: jsonBody({ amount: 9999, currency: "CAD" }),
    }));
    expect(res.statusCode).toBe(409);
    expect(parseBody(res).message).toMatch(/insufficient|OPEN/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 — Idempotency: safe replay (DONE)
// Call order: GET account → GET idempotency (DONE) → return cached, stop
// ─────────────────────────────────────────────────────────────────────────────

describe("idempotency — safe replay on duplicate request", () => {
  beforeEach(() => docClient.send.mockReset());

  test("returns cached 200 response without running the transaction", async () => {
    const cachedResponse = { balance: 1050, accountId: "acct_001" };

    docClient.send
      // [1] pre-check GET account (happens before checkIdempotency)
      .mockResolvedValueOnce({ Item: OPEN_ACCOUNT })
      // [2] checkIdempotency → DONE record found
      .mockResolvedValueOnce({
        Item: {
          idempotencyKey: "key-abc",
          status: "DONE",
          statusCode: 200,
          body: jsonBody(cachedResponse),
        },
      });

    const res = await deposit(withKey("key-abc", {
      pathParameters: { accountId: "acct_001" },
      body: jsonBody({ amount: 50, currency: "CAD" }),
    }));

    expect(res.statusCode).toBe(200);
    expect(parseBody(res)).toEqual(cachedResponse);
    // Only 2 calls: account GET + idempotency GET — no TransactWrite
    expect(docClient.send).toHaveBeenCalledTimes(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6 — Idempotency: request finds PROCESSING → polls → DONE
// Call order: GET account → GET idempotency (PROCESSING) → poll → poll (DONE)
// ─────────────────────────────────────────────────────────────────────────────

describe("idempotency — request finds PROCESSING then waits for DONE", () => {
  beforeEach(() => docClient.send.mockReset());

  test("waits for winner to resolve then returns its cached response", async () => {
    const cachedBody = jsonBody({ balance: 1050 });

    docClient.send
      // [1] pre-check GET account
      .mockResolvedValueOnce({ Item: OPEN_ACCOUNT })
      // [2] checkIdempotency → PROCESSING (another request is in-flight)
      .mockResolvedValueOnce({
        Item: { idempotencyKey: "key-race", status: "PROCESSING", claimedAt: Date.now() - 500 },
      })
      // [3] waitForResolution poll #1 → still PROCESSING
      .mockResolvedValueOnce({
        Item: { idempotencyKey: "key-race", status: "PROCESSING", claimedAt: Date.now() - 600 },
      })
      // [4] waitForResolution poll #2 → DONE ✅
      .mockResolvedValueOnce({
        Item: { idempotencyKey: "key-race", status: "DONE", statusCode: 200, body: cachedBody },
      });

    const res = await deposit(withKey("key-race", {
      pathParameters: { accountId: "acct_001" },
      body: jsonBody({ amount: 50, currency: "CAD" }),
    }));

    expect(res.statusCode).toBe(200);
    expect(parseBody(res).balance).toBe(1050);
    // 4 calls: account GET, idempotency GET, 2 poll GETs
    expect(docClient.send).toHaveBeenCalledTimes(4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7 — Idempotency: loses the TransactWrite race → waits → DONE
// Call order: GET account → GET idempotency (NOT_FOUND) → TransactWrite (LOSES)
//             → poll → poll (DONE)
// ─────────────────────────────────────────────────────────────────────────────

describe("idempotency — loses the TransactWrite race", () => {
  beforeEach(() => docClient.send.mockReset());

  test("loser gets DONE from winner and returns the same response", async () => {
    const cachedBody = jsonBody({ balance: 1050 });

    // The race error: CancellationReasons[0] = idempotency Put was rejected
    const raceError = Object.assign(new Error("Transaction cancelled"), {
      name: "TransactionCanceledException",
      CancellationReasons: [
        { Code: "ConditionalCheckFailed" }, // [0] idempotency Put — LOST THE RACE
        { Code: "None" },                   // [1] balance Update — cancelled along with it
      ],
    });

    docClient.send
      // [1] pre-check GET account
      .mockResolvedValueOnce({ Item: OPEN_ACCOUNT })
      // [2] checkIdempotency → NOT_FOUND (both requests see this simultaneously)
      .mockResolvedValueOnce({ Item: undefined })
      // [3] TransactWriteCommand → LOST (idempotency Put condition failed)
      .mockRejectedValueOnce(raceError)
      // [4] waitForResolution poll #1 → still PROCESSING
      .mockResolvedValueOnce({
        Item: { idempotencyKey: "key-race2", status: "PROCESSING", claimedAt: Date.now() - 200 },
      })
      // [5] waitForResolution poll #2 → DONE ✅
      .mockResolvedValueOnce({
        Item: { idempotencyKey: "key-race2", status: "DONE", statusCode: 200, body: cachedBody },
      });

    const res = await deposit(withKey("key-race2", {
      pathParameters: { accountId: "acct_001" },
      body: jsonBody({ amount: 50, currency: "CAD" }),
    }));

    expect(res.statusCode).toBe(200);
    expect(parseBody(res).balance).toBe(1050);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 8 — Crash recovery: PROCESSING is old + balance matches → self-heal
// ─────────────────────────────────────────────────────────────────────────────

describe("idempotency — crash recovery: balance matches → self-heal", () => {
  const originalSleep = idempotencyLib._sleep;
  beforeEach(() => docClient.send.mockReset());
  afterEach(() => { idempotencyLib._sleep = originalSleep; jest.restoreAllMocks(); });

  test("detects crash, verifies balance matches, resolves to DONE, returns stored response", async () => {
    const recoveryBody = jsonBody({ balance: 1050 });
    const stuckRecord = {
      idempotencyKey:        "key-crash",
      status:                "PROCESSING",
      claimedAt:             1,          // effectively infinitely old → age >> CRASH_THRESHOLD_MS
      verifyAccountId:       "acct_001",
      verifyExpectedBalance: 1050,
      recoveryStatusCode:    200,
      recoveryBody,
    };

    // Make sleep a no-op so the loop is instant
    idempotencyLib._sleep = () => Promise.resolve();

    // Date.now call sequence:
    //   call 1: deadline = baseNow + 3000  (setting deadline)
    //   call 2: baseNow < deadline → enter loop (1st iteration)
    //   call 3: baseNow + 10_000 → exit loop (after 1 poll captured lastRecord)
    const baseNow = 1_000_000;
    let nowCall = 0;
    jest.spyOn(Date, "now").mockImplementation(() => {
      nowCall++;
      if (nowCall <= 2) return baseNow;      // calls 1+2: inside deadline window
      return baseNow + 10_000;               // call 3+: past deadline → exit loop
    });

    docClient.send
      .mockResolvedValueOnce({ Item: OPEN_ACCOUNT })                             // [1] pre-check GET account
      .mockResolvedValueOnce({ Item: stuckRecord })                              // [2] checkIdempotency → PROCESSING
      .mockResolvedValueOnce({ Item: stuckRecord })                              // [3] poll #1 → lastRecord set
      .mockResolvedValueOnce({ Item: { accountId: "acct_001", balance: 1050 } }) // [4] crash verify ✅
      .mockResolvedValueOnce({});                                                // [5] resolveIdempotency

    const res = await deposit(withKey("key-crash", {
      pathParameters: { accountId: "acct_001" },
      body: jsonBody({ amount: 50, currency: "CAD" }),
    }));

    expect(res.statusCode).toBe(200);
    expect(parseBody(res).balance).toBe(1050);
  }, 15_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 9 — Crash recovery: PROCESSING is old + balance mismatch → safe 409
// ─────────────────────────────────────────────────────────────────────────────

describe("idempotency — crash recovery: balance mismatch → safe 409", () => {
  const originalSleep = idempotencyLib._sleep;
  beforeEach(() => docClient.send.mockReset());
  afterEach(() => { idempotencyLib._sleep = originalSleep; jest.restoreAllMocks(); });

  test("confirms transaction never ran when balance does not match — returns 409", async () => {
    const stuckRecord = {
      idempotencyKey:        "key-no-run",
      status:                "PROCESSING",
      claimedAt:             1,          // effectively infinitely old → age >> CRASH_THRESHOLD_MS
      verifyAccountId:       "acct_001",
      verifyExpectedBalance: 1050,
      recoveryStatusCode:    200,
      recoveryBody:          jsonBody({ balance: 1050 }),
    };

    // Make sleep a no-op so the loop is instant
    idempotencyLib._sleep = () => Promise.resolve();

    // Date.now call sequence: call1+2 → inside deadline, call3+ → past deadline
    const baseNow = 1_000_000;
    let nowCall = 0;
    jest.spyOn(Date, "now").mockImplementation(() => {
      nowCall++;
      if (nowCall <= 2) return baseNow;
      return baseNow + 10_000;
    });

    docClient.send
      .mockResolvedValueOnce({ Item: OPEN_ACCOUNT })                            // [1] pre-check GET
      .mockResolvedValueOnce({ Item: stuckRecord })                             // [2] checkIdempotency → PROCESSING
      .mockResolvedValueOnce({ Item: stuckRecord })                             // [3] poll #1 → lastRecord set
      .mockResolvedValueOnce({ Item: { accountId: "acct_001", balance: 1000 } }); // [4] crash verify — mismatch ❌

    const res = await deposit(withKey("key-no-run", {
      pathParameters: { accountId: "acct_001" },
      body: jsonBody({ amount: 50, currency: "CAD" }),
    }));

    expect(res.statusCode).toBe(409);
    expect(parseBody(res).message).toMatch(/Idempotency-Key/);
  }, 15_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 10 — No Idempotency-Key: plain transaction (no idempotency table)
// Call order: GET account → TransactWrite
// ─────────────────────────────────────────────────────────────────────────────

describe("no Idempotency-Key — skips all idempotency logic", () => {
  beforeEach(() => docClient.send.mockReset());

  test("deposit runs with exactly 2 DB calls: account GET + TransactWrite", async () => {
    docClient.send
      .mockResolvedValueOnce({ Item: OPEN_ACCOUNT }) // [1] pre-check GET
      .mockResolvedValueOnce({});                    // [2] TransactWriteCommand

    const res = await deposit(makeEvent({
      pathParameters: { accountId: "acct_001" },
      body: jsonBody({ amount: 100, currency: "CAD" }),
    }));

    expect(res.statusCode).toBe(200);
    // Exactly 2 calls — no idempotency table reads or writes
    expect(docClient.send).toHaveBeenCalledTimes(2);
  });
});
