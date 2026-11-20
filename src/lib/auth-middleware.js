"use strict";

/**
 * Lightweight auth middleware for serverless-offline and direct Lambda invocations.
 *
 * In a real API Gateway + Lambda Authorizer setup the token is verified by the
 * authorizer before the handler is ever invoked, and the decoded claims arrive
 * via event.requestContext.authorizer.  serverless-offline supports custom
 * authorizers but requires extra config; this middleware provides an in-process
 * alternative used by all protected handlers.
 *
 * Usage inside a handler:
 *
 *   const { requireAuth } = require("../lib/auth-middleware");
 *
 *   async function get(event) {
 *     const authResult = requireAuth(event);
 *     if (authResult.error) return authResult.error;
 *     const { customerId } = authResult;
 *     // … proceed
 *   }
 */

const { verifyToken } = require("./jwt");
const { json } = require("./response");

const UNAUTHORIZED = (msg = "Missing or invalid Authorization header") =>
  json(401, { error: "UNAUTHORIZED", message: msg });

const FORBIDDEN = (msg = "You do not have permission to access this resource") =>
  json(403, { error: "FORBIDDEN", message: msg });

/**
 * Extract and verify the Bearer token from the event.
 *
 * Returns:
 *   { customerId, email }          — on success
 *   { error: <response object> }   — on failure (return this directly)
 */
function requireAuth(event) {
  // 1. Check for claims already injected by the Lambda authorizer
  const authorizerCtx = event.requestContext?.authorizer;
  if (authorizerCtx?.customerId) {
    return { customerId: authorizerCtx.customerId, email: authorizerCtx.email };
  }

  // 2. Fall back to verifying the Authorization header directly
  //    (used in tests and serverless-offline without an authorizer configured)
  const headers = event.headers ?? {};
  const authHeader =
    headers["Authorization"] ||
    headers["authorization"] ||
    "";

  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    return { error: UNAUTHORIZED() };
  }

  const token = authHeader.slice(7).trim();

  try {
    const decoded = verifyToken(token);
    return { customerId: decoded.sub, email: decoded.email };
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return { error: UNAUTHORIZED("Token has expired — please log in again") };
    }
    return { error: UNAUTHORIZED() };
  }
}

/**
 * Assert that the authenticated user owns the requested customer resource.
 * Returns a 403 response object if the check fails, or null if it passes.
 *
 * Usage:
 *   const ownerCheck = assertOwner(authResult.customerId, event.pathParameters?.customerId);
 *   if (ownerCheck) return ownerCheck;
 */
function assertOwner(authenticatedCustomerId, requestedCustomerId) {
  if (!requestedCustomerId) return null; // no ownership check needed
  if (authenticatedCustomerId !== requestedCustomerId) {
    return FORBIDDEN();
  }
  return null;
}

module.exports = { requireAuth, assertOwner };
