# NOTES.md — Banking API Assessment

## Implementation Overview

All **core** endpoints and all **stretch** (transaction) endpoints have been implemented.

---

## DynamoDB Access Patterns

### Customers Table
| Operation | DynamoDB command | Key |
|-----------|-----------------|-----|
| Create customer | `PutCommand` | — |
| Get customer | `GetCommand` | `customerId` (PK) |

### Accounts Table
| Operation | DynamoDB command | Key |
|-----------|-----------------|-----|
| Create account | `PutCommand` | — |
| Get account | `GetCommand` | `accountId` (PK) |
| List by customer | `QueryCommand` on `CustomerIdIndex` GSI | `customerId` |
| Deposit | `UpdateCommand` with `SET balance = balance + :amt` | `accountId` (PK) |
| Withdraw | `UpdateCommand` with conditional `balance >= :amt` | `accountId` (PK) |
| Transfer | `TransactWriteCommand` (two `UpdateCommand` items) | both `accountId` PKs |

**Why GSI instead of Scan for `listAccounts`?**
A `Scan` reads every item in the table, consuming RCUs proportional to table size.  
`QueryCommand` on `CustomerIdIndex` only reads items belonging to that customer — O(accounts per customer), not O(total accounts). This is the production-safe pattern for any reasonably sized table.

---

## Transfer Consistency Approach

Transfers use **DynamoDB `TransactWriteItems`** (SDK: `TransactWriteCommand`):

```
TransactItems: [
  { Update: debit fromAccount, ConditionExpression: balance >= amount },
  { Update: credit toAccount }
]
```

**Why this is correct:**
- Both legs are atomic — either both succeed or neither does. No intermediate state is visible to any reader.
- The `ConditionExpression` on the debit leg ensures insufficient-funds rejection aborts the *entire* transaction before money moves.
- DynamoDB returns `TransactionCanceledException` with `CancellationReasons[].Code = "ConditionalCheckFailed"` on the failing item — the handler maps this to `409 CONFLICT`.

**Trade-offs:**
- `TransactWriteItems` has a 100-item limit and costs 2× read + 2× write capacity units (read-before-write for condition evaluation). Fine for a banking API's typical throughput.
- An alternative (for very high TPS) would be a saga/compensation pattern or an event-sourced ledger, but `TransactWrite` is simpler and correct for this scale.

---

## Input Validation

| Field | Rule |
|-------|------|
| `fullName` | Required, non-empty string |
| `email` | Required, must match email regex (`/^[^\s@]+@[^\s@]+\.[^\s@]+$/`) |
| `type` | Enum: `CHECKING`, `SAVINGS` |
| `currency` | Enum: `CAD`, `USD` |
| `initialBalance` | Optional, number >= 0, defaults to 0 |
| `amount` | Required, number > 0 |
| Currency match | Deposit/withdraw/transfer currency must match account currency |
| Same-account transfer | Rejected with 400 |

---

## Automated Tests

Located in `tests/handlers.test.js`. Uses **Jest** with the AWS SDK mocked — no live DynamoDB needed.

```bash
npm test
```

**Coverage:**
- `POST /customers` — happy path, missing body, missing fullName, bad email
- `GET /customers/{customerId}` — found, not found
- `POST /customers/{customerId}/accounts` — happy path, 404 customer, bad type, negative balance
- `GET /customers/{customerId}/accounts` — returns items list, 404 customer
- `GET /accounts/{accountId}` — found, not found
- `POST /accounts/{accountId}/deposits` — happy path, amount ≤ 0, currency mismatch, 404
- `POST /accounts/{accountId}/withdrawals` — happy path, 409 insufficient funds
- `POST /transfers` — happy path, 409 insufficient funds, 400 same account, 404 source not found

---

## IDs

- **Customer IDs** are generated as `cust_` + first 12 hex chars of a UUID v4.
- **Account IDs** are generated as `acct_` + first 12 hex chars of a UUID v4.
- Seeded IDs (`cust_001`, `acct_001`, etc.) remain valid for demos.

---

## What's out of scope (per assessment brief)

- Real AWS deploy / IAM roles
- Frontend UI
- KYC / PCI / AML compliance
- Pagination on `listAccounts` (could be added with `LastEvaluatedKey` / `ExclusiveStartKey` from DynamoDB)
- Account `CLOSED` lifecycle transitions
