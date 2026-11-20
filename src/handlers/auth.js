"use strict";

/**
 * Auth handler — register, login, and Lambda authorizer.
 *
 * Routes (public — no JWT required):
 *   POST /auth/register   Create a user account (hashed password stored in Users table)
 *   POST /auth/login      Validate credentials → return { token }
 *
 * Lambda authorizer:
 *   jwtAuthorizer         Validates Bearer token; injects customerId into
 *                         requestContext.authorizer so downstream handlers can
 *                         read event.requestContext.authorizer.customerId.
 */

const bcrypt = require("bcryptjs");
const { docClient, TABLES } = require("../lib/dynamodb");
const { GetCommand, PutCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");
const { signToken, verifyToken } = require("../lib/jwt");
const { ok, created, badRequest, json, serverError, parseJsonBody } = require("../lib/response");

const EMAIL_RE    = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BCRYPT_ROUNDS = 10;

// ─────────────────────────────────────────────────────────────────────────────
// POST /auth/register
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a new user credential record linked to a customer.
 *
 * Body: { customerId, email, password }
 *   - customerId must reference an existing Customer record
 *   - email must be unique in the Users table
 *   - password is hashed with bcrypt before storage
 *
 * Returns 201: { customerId, email, createdAt }
 */
async function register(event) {
  const parsed = parseJsonBody(event);
  if (!parsed.ok) return parsed.response;

  const { customerId, email, password } = parsed.data;

  if (!customerId || typeof customerId !== "string") {
    return badRequest("customerId is required");
  }
  if (!email || !EMAIL_RE.test(email.trim())) {
    return badRequest("A valid email is required");
  }
  if (!password || typeof password !== "string" || password.length < 8) {
    return badRequest("password must be at least 8 characters");
  }

  const normalizedEmail = email.trim().toLowerCase();

  // 1. Confirm the customer exists
  let customerResult;
  try {
    customerResult = await docClient.send(
      new GetCommand({ TableName: TABLES.customers, Key: { customerId } })
    );
  } catch (err) {
    console.error("register: failed to look up customer:", err);
    return serverError("Failed to verify customer");
  }
  if (!customerResult.Item) {
    return badRequest(`Customer '${customerId}' not found`);
  }

  // 2. Check email uniqueness (GSI: EmailIndex on Users table)
  try {
    const existing = await docClient.send(
      new QueryCommand({
        TableName:                 TABLES.users,
        IndexName:                 "EmailIndex",
        KeyConditionExpression:    "email = :email",
        ExpressionAttributeValues: { ":email": normalizedEmail },
        Limit: 1,
      })
    );
    if ((existing.Items ?? []).length > 0) {
      return json(409, { error: "CONFLICT", message: "An account with this email already exists" });
    }
  } catch (err) {
    console.error("register: failed to check email uniqueness:", err);
    return serverError("Failed to check email availability");
  }

  // 3. Hash password and persist
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  const user = {
    customerId,
    email: normalizedEmail,
    passwordHash,
    createdAt: new Date().toISOString(),
  };

  try {
    await docClient.send(
      new PutCommand({
        TableName:           TABLES.users,
        Item:                user,
        // Guard against two simultaneous registrations for the same customerId
        ConditionExpression: "attribute_not_exists(customerId)",
      })
    );
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      return json(409, { error: "CONFLICT", message: "Credentials already exist for this customer" });
    }
    console.error("register: PutCommand failed:", err);
    return serverError("Failed to create user credentials");
  }

  return created({ customerId, email: normalizedEmail, createdAt: user.createdAt });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /auth/login
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates credentials and returns a signed JWT.
 *
 * Body: { email, password }
 * Returns 200: { token, expiresIn }
 * Returns 401: on bad credentials (intentionally vague — no user enumeration)
 */
async function login(event) {
  const parsed = parseJsonBody(event);
  if (!parsed.ok) return parsed.response;

  const { email, password } = parsed.data;

  if (!email || !password) {
    return badRequest("email and password are required");
  }

  const normalizedEmail = email.trim().toLowerCase();

  // Look up user by email via GSI
  let items;
  try {
    const result = await docClient.send(
      new QueryCommand({
        TableName:                 TABLES.users,
        IndexName:                 "EmailIndex",
        KeyConditionExpression:    "email = :email",
        ExpressionAttributeValues: { ":email": normalizedEmail },
        Limit: 1,
      })
    );
    items = result.Items ?? [];
  } catch (err) {
    console.error("login: QueryCommand failed:", err);
    return serverError("Login failed");
  }

  // Constant-time failure path — always call bcrypt.compare to prevent timing attacks
  const dummyHash = "$2a$10$invalidhashfortimingnormalization000000000000000000000000";
  const user      = items[0] ?? null;
  const hash      = user?.passwordHash ?? dummyHash;

  const valid = await bcrypt.compare(password, hash);
  if (!user || !valid) {
    return json(401, { error: "UNAUTHORIZED", message: "Invalid email or password" });
  }

  const token = signToken({ customerId: user.customerId, email: user.email });

  return ok({
    token,
    expiresIn: process.env.JWT_EXPIRES_IN || "24h",
    customerId: user.customerId,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Lambda Authorizer — jwtAuthorizer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * API Gateway TOKEN-type Lambda authorizer.
 *
 * API Gateway passes:
 *   event.authorizationToken  — the raw "Authorization" header value
 *   event.methodArn           — the ARN of the method being called
 *
 * Must return an IAM policy document. API Gateway caches the response by token.
 *
 * We embed the customerId in the context so downstream handlers can read:
 *   event.requestContext.authorizer.customerId
 */
function jwtAuthorizer(event, context, callback) {
  const authHeader = event.authorizationToken ?? "";

  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    // "Unauthorized" (the string) triggers a 401 response from API Gateway
    return callback("Unauthorized");
  }

  const token = authHeader.slice(7).trim();

  let decoded;
  try {
    decoded = verifyToken(token);
  } catch (err) {
    // Expired or malformed token → 401
    return callback("Unauthorized");
  }

  const policy = buildPolicy(decoded.sub, "Allow", event.methodArn, {
    customerId: decoded.sub,
    email:      decoded.email,
  });

  callback(null, policy);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper — build IAM policy document
// ─────────────────────────────────────────────────────────────────────────────

function buildPolicy(principalId, effect, methodArn, context = {}) {
  // Allow access to all methods under the same API/stage to avoid cache thrashing
  const arnParts  = methodArn.split(":");
  const region    = arnParts[3];
  const accountId = arnParts[4];
  const apiGwParts = arnParts[5].split("/");
  const restApiId  = apiGwParts[0];
  const stage      = apiGwParts[1];
  const wildcardArn = `arn:aws:execute-api:${region}:${accountId}:${restApiId}/${stage}/*/*`;

  return {
    principalId,
    policyDocument: {
      Version:   "2012-10-17",
      Statement: [
        {
          Action:   "execute-api:Invoke",
          Effect:   effect,
          Resource: wildcardArn,
        },
      ],
    },
    context, // passed to downstream as event.requestContext.authorizer.*
  };
}

module.exports = { register, login, jwtAuthorizer };
