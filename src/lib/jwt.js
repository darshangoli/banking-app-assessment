"use strict";

/**
 * JWT helpers — sign and verify tokens.
 *
 * Algorithm : HS256 (HMAC-SHA256)
 * Secret    : JWT_SECRET env var (must be set in production — min 32 chars)
 * Expiry    : JWT_EXPIRES_IN env var (default "24h")
 *
 * Token payload:
 *   { sub: customerId, email, iat, exp }
 */

const jwt = require("jsonwebtoken");

const SECRET     = process.env.JWT_SECRET     || "dev-secret-change-in-production-min-32-chars";
const EXPIRES_IN = process.env.JWT_EXPIRES_IN || "24h";

/**
 * Sign a JWT for the given customer.
 * @param {{ customerId: string, email: string }} payload
 * @returns {string} signed JWT
 */
function signToken({ customerId, email }) {
  return jwt.sign({ sub: customerId, email }, SECRET, {
    algorithm: "HS256",
    expiresIn: EXPIRES_IN,
  });
}

/**
 * Verify a JWT and return the decoded payload.
 * Throws JsonWebTokenError / TokenExpiredError on failure.
 * @param {string} token - raw JWT string (without "Bearer " prefix)
 * @returns {{ sub: string, email: string, iat: number, exp: number }}
 */
function verifyToken(token) {
  return jwt.verify(token, SECRET, { algorithms: ["HS256"] });
}

module.exports = { signToken, verifyToken };
