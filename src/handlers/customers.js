"use strict";

const { ok, created, badRequest, notFound, serverError, parseJsonBody } = require("../lib/response");
const { docClient, TABLES } = require("../lib/dynamodb");
const { GetCommand, PutCommand, ScanCommand } = require("@aws-sdk/lib-dynamodb");
const { requireAuth, assertOwner } = require("../lib/auth-middleware");

// Simple email regex — good enough for input validation without a heavy dep
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Generates the next sequential customerId in the format cust_NNN.
 * Scans the table, finds the highest existing numeric suffix, and increments it.
 */
async function nextCustomerId() {
  const result = await docClient.send(
    new ScanCommand({
      TableName: TABLES.customers,
      ProjectionExpression: "customerId",
    })
  );

  let max = 0;
  for (const item of result.Items ?? []) {
    const match = item.customerId?.match(/^cust_(\d+)$/);
    if (match) {
      const n = parseInt(match[1], 10);
      if (n > max) max = n;
    }
  }

  return `cust_${String(max + 1).padStart(3, "0")}`;
}

/**
 * POST /customers
 *
 * Validates fullName and email, generates a customerId, persists to DynamoDB,
 * and returns the created Customer object with 201.
 *
 * Protected: requires a valid JWT. Any authenticated user can create a customer
 * record (admin-style creation). In a real system you'd gate this further.
 */
async function create(event) {
  const authResult = requireAuth(event);
  if (authResult.error) return authResult.error;

  const parsed = parseJsonBody(event);
  if (!parsed.ok) {
    return parsed.response;
  }
  const { fullName, email } = parsed.data;
  if (!fullName || typeof fullName !== "string" || fullName.trim().length === 0) {
    return badRequest("fullName is required and must be a non-empty string");
  }
  if (!email || typeof email !== "string" || !EMAIL_RE.test(email.trim())) {
    return badRequest("email is required and must be a valid email address");
  }
  let customerId;
  try {
    customerId = await nextCustomerId();
  } catch (err) {
    console.error("Failed to generate customerId:", err);
    return serverError("Failed to generate customer ID");
  }
  const customer = {
    customerId,
    fullName: fullName.trim(),
    email: email.trim().toLowerCase(),
    status: "ACTIVE",
    createdAt: new Date().toISOString(),
  };

  try {
    await docClient.send(
      new PutCommand({
        TableName: TABLES.customers,
        Item: customer,
      })
    );
  } catch (err) {
    console.error("DynamoDB PutCommand failed (customers):", err);
    return serverError("Failed to create customer");
  }

  return created(customer);
}

/**
 * GET /customers/{customerId}
 *
 * Fetches a customer by customerId. Returns 200 with Customer or 404 if not found.
 * Protected: authenticated users may only read their own customer record.
 */
async function get(event) {
  const authResult = requireAuth(event);
  if (authResult.error) return authResult.error;

  const customerId = event.pathParameters?.customerId;
  if (!customerId) {
    return badRequest("customerId path parameter is required");
  }

  const ownerCheck = assertOwner(authResult.customerId, customerId);
  if (ownerCheck) return ownerCheck;
  try {
    const result = await docClient.send(
      new GetCommand({
        TableName: TABLES.customers,
        Key: { customerId },
      })
    );
    if (!result.Item) {
      return notFound(`Customer '${customerId}' not found`);
    }
    return ok(result.Item);
  } catch (err) {
    console.error("DynamoDB GetCommand failed (customers):", err);
    return serverError("Failed to fetch customer");
  }
}

module.exports = {
  create,
  get,
};
