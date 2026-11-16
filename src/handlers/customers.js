"use strict";

const { ok, created, badRequest, notFound, serverError, parseJsonBody } = require("../lib/response");
const { docClient, TABLES } = require("../lib/dynamodb");
const { GetCommand, PutCommand } = require("@aws-sdk/lib-dynamodb");
const { v4: uuidv4 } = require("uuid");

// Simple email regex — good enough for input validation without a heavy dep
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * POST /customers
 *
 * Validates fullName and email, generates a customerId, persists to DynamoDB,
 * and returns the created Customer object with 201.
 */
async function create(event) {
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

  const customer = {
    customerId: `cust_${uuidv4().replace(/-/g, "").slice(0, 12)}`,
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
 */
async function get(event) {
  const customerId = event.pathParameters?.customerId;

  if (!customerId) {
    return badRequest("customerId path parameter is required");
  }

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
