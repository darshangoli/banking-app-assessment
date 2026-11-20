"use strict";

/**
 * Lightweight integration-style unit tests.
 *
 * These tests run against the real handlers using mock DynamoDB calls via
 * Jest manual mocking.  No network required — the AWS SDK is mocked at the
 * module level.
 *
 * Run:  npm test
 */

// ─── Mock the DynamoDB document client ───────────────────────────────────────
jest.mock("../src/lib/dynamodb", () => ({
  docClient: { send: jest.fn() },
  TABLES: { customers: "Customers", accounts: "Accounts", idempotency: "Idempotency", users: "Users" },
}));

// ─── Mock auth middleware — always authenticated as cust_001 ─────────────────
jest.mock("../src/lib/auth-middleware", () => ({
  requireAuth: () => ({ customerId: "cust_001", email: "test@example.com" }),
  assertOwner: () => null,
}));

const { docClient } = require("../src/lib/dynamodb");

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeEvent(overrides = {}) {
  return {
    pathParameters: null,
    body: null,
    isBase64Encoded: false,
    ...overrides,
  };
}

function jsonBody(obj) {
  return JSON.stringify(obj);
}

function parseBody(response) {
  return JSON.parse(response.body);
}

// ─── Customer handlers ────────────────────────────────────────────────────────

describe("POST /customers", () => {
  const { create } = require("../src/handlers/customers");

  beforeEach(() => docClient.send.mockReset());

  test("201 – creates a customer with valid input", async () => {
    docClient.send.mockResolvedValueOnce({}); // PutCommand succeeds

    const event = makeEvent({ body: jsonBody({ fullName: "Ada Lovelace", email: "ada@example.com" }) });
    const res = await create(event);

    expect(res.statusCode).toBe(201);
    const body = parseBody(res);
    expect(body.customerId).toMatch(/^cust_/);
    expect(body.fullName).toBe("Ada Lovelace");
    expect(body.email).toBe("ada@example.com");
    expect(body.status).toBe("ACTIVE");
    expect(body.createdAt).toBeTruthy();
  });

  test("400 – missing body", async () => {
    const res = await create(makeEvent({ body: null }));
    expect(res.statusCode).toBe(400);
  });

  test("400 – missing fullName", async () => {
    const res = await create(makeEvent({ body: jsonBody({ email: "x@y.com" }) }));
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).error).toBe("BAD_REQUEST");
  });

  test("400 – invalid email format", async () => {
    const res = await create(makeEvent({ body: jsonBody({ fullName: "Alice", email: "not-an-email" }) }));
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).error).toBe("BAD_REQUEST");
  });
});

describe("GET /customers/{customerId}", () => {
  const { get } = require("../src/handlers/customers");

  beforeEach(() => docClient.send.mockReset());

  test("200 – returns existing customer", async () => {
    const customer = { customerId: "cust_001", fullName: "Ada", email: "ada@example.com", status: "ACTIVE", createdAt: "2024-01-01T00:00:00Z" };
    docClient.send.mockResolvedValueOnce({ Item: customer });

    const res = await get(makeEvent({ pathParameters: { customerId: "cust_001" } }));
    expect(res.statusCode).toBe(200);
    expect(parseBody(res)).toEqual(customer);
  });

  test("404 – customer not found", async () => {
    docClient.send.mockResolvedValueOnce({ Item: undefined });

    const res = await get(makeEvent({ pathParameters: { customerId: "cust_missing" } }));
    expect(res.statusCode).toBe(404);
    expect(parseBody(res).error).toBe("NOT_FOUND");
  });
});

// ─── Account handlers ─────────────────────────────────────────────────────────

describe("POST /customers/{customerId}/accounts", () => {
  const { create } = require("../src/handlers/accounts");

  beforeEach(() => docClient.send.mockReset());

  test("201 – creates account with valid input", async () => {
    // First call: GetCommand for customer; second call: PutCommand for account
    docClient.send
      .mockResolvedValueOnce({ Item: { customerId: "cust_001" } })
      .mockResolvedValueOnce({});

    const event = makeEvent({
      pathParameters: { customerId: "cust_001" },
      body: jsonBody({ type: "CHECKING", currency: "CAD", initialBalance: 500 }),
    });
    const res = await create(event);

    expect(res.statusCode).toBe(201);
    const body = parseBody(res);
    expect(body.accountId).toMatch(/^acct_/);
    expect(body.type).toBe("CHECKING");
    expect(body.currency).toBe("CAD");
    expect(body.balance).toBe(500);
    expect(body.status).toBe("OPEN");
  });

  test("404 – customer not found", async () => {
    docClient.send.mockResolvedValueOnce({ Item: undefined });

    const res = await create(makeEvent({
      pathParameters: { customerId: "cust_ghost" },
      body: jsonBody({ type: "SAVINGS", currency: "USD" }),
    }));
    expect(res.statusCode).toBe(404);
  });

  test("400 – invalid account type", async () => {
    docClient.send.mockResolvedValueOnce({ Item: { customerId: "cust_001" } });

    const res = await create(makeEvent({
      pathParameters: { customerId: "cust_001" },
      body: jsonBody({ type: "INVESTMENT", currency: "CAD" }),
    }));
    expect(res.statusCode).toBe(400);
  });

  test("400 – negative initialBalance", async () => {
    docClient.send.mockResolvedValueOnce({ Item: { customerId: "cust_001" } });

    const res = await create(makeEvent({
      pathParameters: { customerId: "cust_001" },
      body: jsonBody({ type: "SAVINGS", currency: "CAD", initialBalance: -10 }),
    }));
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /customers/{customerId}/accounts", () => {
  const { list } = require("../src/handlers/accounts");

  beforeEach(() => docClient.send.mockReset());

  test("200 – returns account list via GSI query", async () => {
    const accounts = [
      { accountId: "acct_001", customerId: "cust_001", type: "CHECKING", currency: "CAD", balance: 250, status: "OPEN", createdAt: "2024-01-01T00:00:00Z" },
    ];
    docClient.send
      .mockResolvedValueOnce({ Item: { customerId: "cust_001" } }) // customer check
      .mockResolvedValueOnce({ Items: accounts });                   // GSI query

    const res = await list(makeEvent({ pathParameters: { customerId: "cust_001" } }));
    expect(res.statusCode).toBe(200);
    expect(parseBody(res)).toEqual({ items: accounts, nextToken: null });
  });

  test("404 – customer not found", async () => {
    docClient.send.mockResolvedValueOnce({ Item: undefined });

    const res = await list(makeEvent({ pathParameters: { customerId: "cust_ghost" } }));
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /accounts/{accountId}", () => {
  const { get } = require("../src/handlers/accounts");

  beforeEach(() => docClient.send.mockReset());

  test("200 – returns existing account", async () => {
    const account = { accountId: "acct_001", customerId: "cust_001", type: "CHECKING", currency: "CAD", balance: 250, status: "OPEN", createdAt: "2024-01-01T00:00:00Z" };
    docClient.send.mockResolvedValueOnce({ Item: account });

    const res = await get(makeEvent({ pathParameters: { accountId: "acct_001" } }));
    expect(res.statusCode).toBe(200);
    expect(parseBody(res)).toEqual(account);
  });

  test("404 – account not found", async () => {
    docClient.send.mockResolvedValueOnce({ Item: undefined });

    const res = await get(makeEvent({ pathParameters: { accountId: "acct_missing" } }));
    expect(res.statusCode).toBe(404);
  });
});

// ─── Transaction handlers ─────────────────────────────────────────────────────

describe("POST /accounts/{accountId}/deposits", () => {
  const { deposit } = require("../src/handlers/transactions");

  beforeEach(() => docClient.send.mockReset());

  test("200 – deposits successfully", async () => {
    docClient.send
      .mockResolvedValueOnce({ Item: { accountId: "acct_001", currency: "CAD", balance: 250, status: "OPEN" } }) // pre-check GET
      .mockResolvedValueOnce({}); // TransactWriteCommand

    const res = await deposit(makeEvent({
      pathParameters: { accountId: "acct_001" },
      body: jsonBody({ amount: 50, currency: "CAD" }),
    }));
    expect(res.statusCode).toBe(200);
    expect(parseBody(res).balance).toBe(300);
  });

  test("400 – amount must be > 0", async () => {
    const res = await deposit(makeEvent({
      pathParameters: { accountId: "acct_001" },
      body: jsonBody({ amount: 0, currency: "CAD" }),
    }));
    expect(res.statusCode).toBe(400);
  });

  test("400 – currency mismatch", async () => {
    docClient.send.mockResolvedValueOnce({ Item: { accountId: "acct_001", currency: "CAD", balance: 250, status: "OPEN" } });

    const res = await deposit(makeEvent({
      pathParameters: { accountId: "acct_001" },
      body: jsonBody({ amount: 50, currency: "USD" }),
    }));
    expect(res.statusCode).toBe(400);
  });

  test("404 – account not found", async () => {
    docClient.send.mockResolvedValueOnce({ Item: undefined });

    const res = await deposit(makeEvent({
      pathParameters: { accountId: "acct_ghost" },
      body: jsonBody({ amount: 50, currency: "CAD" }),
    }));
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /accounts/{accountId}/withdrawals", () => {
  const { withdraw } = require("../src/handlers/transactions");

  beforeEach(() => docClient.send.mockReset());

  test("200 – withdraws successfully", async () => {
    docClient.send
      .mockResolvedValueOnce({ Item: { accountId: "acct_001", currency: "CAD", balance: 250, status: "OPEN" } }) // pre-check GET
      .mockResolvedValueOnce({}); // TransactWriteCommand

    const res = await withdraw(makeEvent({
      pathParameters: { accountId: "acct_001" },
      body: jsonBody({ amount: 50, currency: "CAD" }),
    }));
    expect(res.statusCode).toBe(200);
    expect(parseBody(res).balance).toBe(200);
  });

  test("409 – insufficient funds", async () => {
    const txError = Object.assign(new Error("Transaction cancelled"), {
      name: "TransactionCanceledException",
      // No idempotency key → business item is at index 0
      CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
    });
    docClient.send
      .mockResolvedValueOnce({ Item: { accountId: "acct_001", currency: "CAD", balance: 10, status: "OPEN" } })
      .mockRejectedValueOnce(txError);

    const res = await withdraw(makeEvent({
      pathParameters: { accountId: "acct_001" },
      body: jsonBody({ amount: 999, currency: "CAD" }),
    }));
    expect(res.statusCode).toBe(409);
    expect(parseBody(res).error).toBe("CONFLICT");
  });
});

describe("POST /transfers", () => {
  const { transfer } = require("../src/handlers/transactions");

  beforeEach(() => docClient.send.mockReset());

  test("200 – transfer completes", async () => {
    const fromAcc = { accountId: "acct_001", currency: "CAD", balance: 250, status: "OPEN" };
    const toAcc   = { accountId: "acct_002", currency: "CAD", balance: 100, status: "OPEN" };

    docClient.send
      .mockResolvedValueOnce({ Item: fromAcc }) // fetchAccount(from)
      .mockResolvedValueOnce({ Item: toAcc })   // fetchAccount(to)
      .mockResolvedValueOnce({});               // TransactWriteCommand

    const res = await transfer(makeEvent({
      body: jsonBody({ fromAccountId: "acct_001", toAccountId: "acct_002", amount: 50, currency: "CAD" }),
    }));
    expect(res.statusCode).toBe(200);
    const body = parseBody(res);
    expect(body.fromAccount.balance).toBe(200); // 250 - 50
    expect(body.toAccount.balance).toBe(150);   // 100 + 50
  });

  test("409 – insufficient funds in source", async () => {
    const txError = Object.assign(new Error("Transaction cancelled"), {
      name: "TransactionCanceledException",
      // No idempotency key → business items start at index 0
      CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }],
    });
    docClient.send
      .mockResolvedValueOnce({ Item: { accountId: "acct_001", currency: "CAD", balance: 10, status: "OPEN" } })
      .mockResolvedValueOnce({ Item: { accountId: "acct_002", currency: "CAD", balance: 100, status: "OPEN" } })
      .mockRejectedValueOnce(txError);

    const res = await transfer(makeEvent({
      body: jsonBody({ fromAccountId: "acct_001", toAccountId: "acct_002", amount: 500, currency: "CAD" }),
    }));
    expect(res.statusCode).toBe(409);
  });

  test("400 – same account transfer rejected", async () => {
    const res = await transfer(makeEvent({
      body: jsonBody({ fromAccountId: "acct_001", toAccountId: "acct_001", amount: 10, currency: "CAD" }),
    }));
    expect(res.statusCode).toBe(400);
  });

  test("404 – source account not found", async () => {
    docClient.send
      .mockResolvedValueOnce({ Item: undefined })
      .mockResolvedValueOnce({ Item: { accountId: "acct_002", currency: "CAD", balance: 100, status: "OPEN" } });

    const res = await transfer(makeEvent({
      body: jsonBody({ fromAccountId: "acct_ghost", toAccountId: "acct_002", amount: 10, currency: "CAD" }),
    }));
    expect(res.statusCode).toBe(404);
  });
});
