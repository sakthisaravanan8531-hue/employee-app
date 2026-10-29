import { test } from "node:test";
import assert from "node:assert/strict";
import { DynamoStore } from "../src/dynamo-store.js";
const data = {
  name: "Alex",
  email: "alex@example.test",
  department: "Engineering",
  title: "Engineer",
};
const old = {
  ...data,
  id: "id-1",
  pk: "EMPLOYEE#id-1",
  revision: "old-revision",
  created_at: "2026-01-01",
};
test("DynamoDB create atomically reserves email and stores employee", async () => {
  let sent;
  const db = new DynamoStore("employees", {
    send: async (command) => {
      sent = command.input;
      return {};
    },
  });
  const item = await db.create(data);
  assert.equal(sent.TransactItems.length, 2);
  assert.equal(sent.TransactItems[1].Put.Item.pk, "EMAIL#" + data.email);
  assert.equal(
    sent.TransactItems[0].Put.ConditionExpression,
    "attribute_not_exists(pk)",
  );
  assert.equal(item.pk, undefined);
  assert.equal(item.revision, undefined);
  assert.ok(item.id);
});
test("DynamoDB duplicate email condition maps to conflict", async () => {
  const db = new DynamoStore("employees", {
    send: async () => {
      throw Object.assign(new Error("cancelled"), {
        name: "TransactionCanceledException",
        CancellationReasons: [
          { Code: "None" },
          { Code: "ConditionalCheckFailed" },
        ],
      });
    },
  });
  await assert.rejects(
    () => db.create(data),
    (e) => e.code === "DUPLICATE",
  );
});
test("DynamoDB update moves email reservation with optimistic concurrency", async () => {
  const sent = [];
  const db = new DynamoStore("employees", {
    send: async (command) => {
      sent.push(command.input);
      return { Item: old };
    },
  });
  const item = await db.update("id-1", { ...data, email: "new@example.test" });
  const tx = sent[1].TransactItems;
  assert.equal(tx.length, 3);
  assert.equal(
    tx[0].Put.ExpressionAttributeValues[":previous"],
    "old-revision",
  );
  assert.equal(tx[1].Delete.Key.pk, "EMAIL#" + data.email);
  assert.equal(tx[2].Put.Item.pk, "EMAIL#new@example.test");
  assert.equal(item.id, "id-1");
});
test("DynamoDB same-email update avoids multiple operations on one key", async () => {
  const sent = [];
  const db = new DynamoStore("employees", {
    send: async (command) => {
      sent.push(command.input);
      return { Item: old };
    },
  });
  await db.update("id-1", { ...data, title: "Lead" });
  assert.equal(sent[1].TransactItems.length, 1);
});
test("DynamoDB concurrent edits fail instead of silently overwriting", async () => {
  let count = 0;
  const db = new DynamoStore("employees", {
    send: async () => {
      if (!count++) return { Item: old };
      throw Object.assign(new Error("cancelled"), {
        name: "TransactionCanceledException",
        CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
      });
    },
  });
  await assert.rejects(
    () => db.update("id-1", data),
    (e) => e.code === "CONFLICT",
  );
});
test("DynamoDB list paginates and hides internal reservation records", async () => {
  const sent = [];
  const db = new DynamoStore("employees", {
    send: async (command) => {
      sent.push(command.input);
      return sent.length === 1
        ? { Items: [old], LastEvaluatedKey: { pk: "next" } }
        : { Items: [{ ...old, id: "id-2", created_at: "2026-02-01" }] };
    },
  });
  const items = await db.list();
  assert.equal(items.length, 2);
  assert.equal(items[0].id, "id-2");
  assert.equal(items[0].pk, undefined);
  assert.deepEqual(sent[1].ExclusiveStartKey, { pk: "next" });
  assert.equal(sent[0].FilterExpression, "begins_with(pk, :prefix)");
});
test("DynamoDB delete removes employee and its email reservation atomically", async () => {
  const sent = [];
  const db = new DynamoStore("employees", {
    send: async (command) => {
      sent.push(command.input);
      return { Item: old };
    },
  });
  assert.equal(await db.delete("id-1"), true);
  assert.equal(sent[1].TransactItems.length, 2);
  assert.equal(sent[1].TransactItems[1].Delete.Key.pk, "EMAIL#" + data.email);
});
test("DynamoDB missing employees return not found without writes", async () => {
  let calls = 0;
  const db = new DynamoStore("employees", {
    send: async () => {
      calls++;
      return {};
    },
  });
  assert.equal(await db.update("missing", data), null);
  assert.equal(await db.delete("missing"), false);
  assert.equal(calls, 2);
});
