"use strict";

/**
 * Validates and normalises a monetary amount.
 *
 * Rules:
 *  - Must be a finite number (or a string that parses to one).
 *  - Must be > 0.
 *  - Must have at most 2 decimal places (guards against floating-point drift
 *    such as 0.1 + 0.2 = 0.30000000000000004).
 *
 * Returns { ok: true, value } on success where `value` is the amount rounded
 * to 2 decimal places as a JS number stored to DynamoDB as a Number.
 * Returns { ok: false, message } on failure.
 */
function validateAmount(raw) {
  const num = Number(raw);

  if (raw === undefined || raw === null || raw === "") {
    return { ok: false, message: "amount is required" };
  }

  if (!isFinite(num)) {
    return { ok: false, message: "amount must be a finite number" };
  }

  if (num <= 0) {
    return { ok: false, message: "amount must be greater than 0" };
  }

  // Reject more than 2 decimal places — avoids floating-point precision bugs.
  // Multiply by 100 and check that the result is a whole integer.
  if (Math.round(num * 100) !== num * 100) {
    return {
      ok: false,
      message: "amount must have at most 2 decimal places (e.g. 10.50)",
    };
  }

  // Store as a rounded 2-dp number to prevent any residual float drift.
  return { ok: true, value: Math.round(num * 100) / 100 };
}

module.exports = { validateAmount };
