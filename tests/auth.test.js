"use strict";

/**
 * Tests for JWT auth: register, login, and middleware protection.
 *
 * The DynamoDB mock is set up globally. Each describe resets it in beforeEach.
 */

jest.mock("../src/lib/dynamodb", () => ({
  docClient: { send: jest.fn() },
  TABLES: {
    customers:   "Customers",
    accounts:    "Accounts",
    idempotency: "Idempotency",
    users:       "Users",
  },
}));

// bcryptjs is slow (10 rounds). Override BCRYPT_ROUNDS via env before the
// module loads, or just mock bcryptjs directly for unit tests.
jest.mock("bcryptjs", () => ({
  hash:    jest.fn().mockResolvedValue("$hashed$"),
  compare: jest.fn(),
}));

const { docClient } = require("../src/lib/dynamodb");
const bcrypt = require("bcryptjs");
const { register, login }  = require("../src/handlers/auth");
const { signToken }        = require("../src/lib/jwt");
const { requireAuth }      = require("../src/lib/auth-middleware");

function makeEvent(overrides = {}) {
  return {
    pathParameters:        null,
    queryStringParameters: null,
    headers:               {},
    body:                  null,
    isBase64Encoded:       false,
    requestContext:        {},
    ...overrides,
  };
}

function jsonBody(obj) { return JSON.stringify(obj); }
function parseBody(res) { return JSON.parse(res.body); }

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const CUSTOMER = {
  customerId: "cust_001",
  fullName:   "Alice",
  email:      "alice@example.com",
  status:     "ACTIVE",
  createdAt:  "2024-01-01T00:00:00Z",
};

const USER_RECORD = {
  customerId:   "cust_001",
  email:        "alice@example.com",
  passwordHash: "$hashed$",
  createdAt:    "2024-01-01T00:00:00Z",
};

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — register
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /auth/register", () => {
  beforeEach(() => { docClient.send.mockReset(); bcrypt.hash.mockResolvedValue("$hashed$"); });

  test("201 — creates user record when customer exists and email is unique", async () => {
    docClient.send
      .mockResolvedValueOnce({ Item: CUSTOMER })   // GetCommand: customer lookup
      .mockResolvedValueOnce({ Items: [] })         // QueryCommand: email uniqueness (EmailIndex)
      .mockResolvedValueOnce({});                   // PutCommand: insert user

    const res = await register(makeEvent({
      body: jsonBody({ customerId: "cust_001", email: "alice@example.com", password: "secret123" }),
    }));

    expect(res.statusCode).toBe(201);
    const body = parseBody(res);
    expect(body.customerId).toBe("cust_001");
    expect(body.email).toBe("alice@example.com");
    expect(body).not.toHaveProperty("passwordHash");
  });

  test("400 — missing customerId", async () => {
    const res = await register(makeEvent({
      body: jsonBody({ email: "a@b.com", password: "secret123" }),
    }));
    expect(res.statusCode).toBe(400);
  });

  test("400 — invalid email", async () => {
    const res = await register(makeEvent({
      body: jsonBody({ customerId: "cust_001", email: "not-an-email", password: "secret123" }),
    }));
    expect(res.statusCode).toBe(400);
  });

  test("400 — password too short", async () => {
    const res = await register(makeEvent({
      body: jsonBody({ customerId: "cust_001", email: "a@b.com", password: "short" }),
    }));
    expect(res.statusCode).toBe(400);
  });

  test("400 — customer not found", async () => {
    docClient.send.mockResolvedValueOnce({ Item: undefined }); // customer not found
    const res = await register(makeEvent({
      body: jsonBody({ customerId: "cust_999", email: "a@b.com", password: "secret123" }),
    }));
    expect(res.statusCode).toBe(400);
    expect(parseBody(res).message).toMatch(/not found/i);
  });

  test("409 — email already taken", async () => {
    docClient.send
      .mockResolvedValueOnce({ Item: CUSTOMER })       // customer exists
      .mockResolvedValueOnce({ Items: [USER_RECORD] }); // email already in use

    const res = await register(makeEvent({
      body: jsonBody({ customerId: "cust_001", email: "alice@example.com", password: "secret123" }),
    }));
    expect(res.statusCode).toBe(409);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — login
// ─────────────────────────────────────────────────────────────────────────────

describe("POST /auth/login", () => {
  beforeEach(() => { docClient.send.mockReset(); });

  test("200 — returns JWT token on valid credentials", async () => {
    docClient.send.mockResolvedValueOnce({ Items: [USER_RECORD] });
    bcrypt.compare.mockResolvedValueOnce(true);

    const res = await login(makeEvent({
      body: jsonBody({ email: "alice@example.com", password: "secret123" }),
    }));

    expect(res.statusCode).toBe(200);
    const body = parseBody(res);
    expect(body).toHaveProperty("token");
    expect(typeof body.token).toBe("string");
    expect(body.customerId).toBe("cust_001");
  });

  test("401 — wrong password", async () => {
    docClient.send.mockResolvedValueOnce({ Items: [USER_RECORD] });
    bcrypt.compare.mockResolvedValueOnce(false);

    const res = await login(makeEvent({
      body: jsonBody({ email: "alice@example.com", password: "wrongpass" }),
    }));
    expect(res.statusCode).toBe(401);
  });

  test("401 — user not found (email unknown)", async () => {
    docClient.send.mockResolvedValueOnce({ Items: [] });
    bcrypt.compare.mockResolvedValueOnce(false); // dummy compare still runs

    const res = await login(makeEvent({
      body: jsonBody({ email: "ghost@example.com", password: "secret123" }),
    }));
    expect(res.statusCode).toBe(401);
  });

  test("400 — missing email or password", async () => {
    const res = await login(makeEvent({ body: jsonBody({ email: "a@b.com" }) }));
    expect(res.statusCode).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — requireAuth middleware
// ─────────────────────────────────────────────────────────────────────────────

describe("requireAuth middleware", () => {
  test("extracts customerId from a valid Bearer token", () => {
    const token = signToken({ customerId: "cust_001", email: "alice@example.com" });
    const event = makeEvent({ headers: { Authorization: `Bearer ${token}` } });
    const result = requireAuth(event);
    expect(result.error).toBeUndefined();
    expect(result.customerId).toBe("cust_001");
    expect(result.email).toBe("alice@example.com");
  });

  test("returns 401 when Authorization header is missing", () => {
    const result = requireAuth(makeEvent({ headers: {} }));
    expect(result.error).toBeDefined();
    expect(result.error.statusCode).toBe(401);
  });

  test("returns 401 for a malformed token", () => {
    const result = requireAuth(makeEvent({ headers: { Authorization: "Bearer not.a.jwt" } }));
    expect(result.error).toBeDefined();
    expect(result.error.statusCode).toBe(401);
  });

  test("extracts customerId from requestContext.authorizer (Lambda authorizer injection)", () => {
    const event = makeEvent({
      requestContext: { authorizer: { customerId: "cust_002", email: "bob@example.com" } },
    });
    const result = requireAuth(event);
    expect(result.error).toBeUndefined();
    expect(result.customerId).toBe("cust_002");
  });
});
