/**
 * Quick script to dump all Customers and Accounts from DynamoDB Local.
 * Run: node scripts/view-data.js
 */
"use strict";

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, ScanCommand } = require("@aws-sdk/lib-dynamodb");

const client = DynamoDBDocumentClient.from(
  new DynamoDBClient({
    region: "us-east-1",
    endpoint: process.env.DYNAMODB_ENDPOINT || "http://localhost:8000",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  })
);

async function scanTable(tableName) {
  const result = await client.send(new ScanCommand({ TableName: tableName }));
  return result.Items ?? [];
}

async function main() {
  console.log("\n========== CUSTOMERS ==========");
  const customers = await scanTable("Customers");
  if (customers.length === 0) {
    console.log("(no records)");
  } else {
    customers.forEach((c) => console.log(JSON.stringify(c, null, 2)));
  }

  console.log("\n========== ACCOUNTS ==========");
  const accounts = await scanTable("Accounts");
  if (accounts.length === 0) {
    console.log("(no records)");
  } else {
    accounts.forEach((a) => console.log(JSON.stringify(a, null, 2)));
  }

  console.log(`\nTotal: ${customers.length} customer(s), ${accounts.length} account(s)\n`);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
