import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
const rowKey = (id) => `EMPLOYEE#${id}`;
const emailKey = (email) => `EMAIL#${email}`;
function publicItem(item) {
  if (!item) return null;
  const { pk, revision, ...data } = item;
  return data;
}
export class DynamoStore {
  constructor(
    tableName,
    client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    }),
  ) {
    this.table = tableName;
    this.client = client;
  }
  async health() {
    await this.client.send(
      new GetCommand({
        TableName: this.table,
        Key: { pk: "HEALTH" },
        ConsistentRead: true,
      }),
    );
  }
  async raw(id) {
    return (
      await this.client.send(
        new GetCommand({
          TableName: this.table,
          Key: { pk: rowKey(id) },
          ConsistentRead: true,
        }),
      )
    ).Item;
  }
  async get(id) {
    return publicItem(await this.raw(id));
  }
  async list() {
    let start;
    const records = [];
    do {
      const page = await this.client.send(
        new ScanCommand({
          TableName: this.table,
          FilterExpression: "begins_with(pk, :prefix)",
          ExpressionAttributeValues: { ":prefix": "EMPLOYEE#" },
          ConsistentRead: true,
          ExclusiveStartKey: start,
        }),
      );
      records.push(...(page.Items || []).map(publicItem));
      start = page.LastEvaluatedKey;
    } while (start);
    return records.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  async write(items, emailIndex) {
    try {
      await this.client.send(
        new TransactWriteCommand({ TransactItems: items }),
      );
    } catch (error) {
      if (
        error.name === "TransactionCanceledException" &&
        error.CancellationReasons?.some(
          (r) => r.Code === "ConditionalCheckFailed",
        )
      ) {
        if (
          error.CancellationReasons[emailIndex]?.Code ===
          "ConditionalCheckFailed"
        )
          throw Object.assign(new Error("Email already exists"), {
            code: "DUPLICATE",
          });
        throw Object.assign(new Error("Employee changed; refresh and retry"), {
          code: "CONFLICT",
        });
      }
      throw error;
    }
  }
  async create(data) {
    const item = {
      ...data,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      revision: randomUUID(),
    };
    await this.write(
      [
        {
          Put: {
            TableName: this.table,
            Item: { ...item, pk: rowKey(item.id) },
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
        {
          Put: {
            TableName: this.table,
            Item: { pk: emailKey(item.email), owner: item.id },
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
      ],
      1,
    );
    return publicItem(item);
  }
  async update(id, data) {
    const old = await this.raw(id);
    if (!old) return null;
    const item = { ...old, ...data, revision: randomUUID() };
    const items = [
      {
        Put: {
          TableName: this.table,
          Item: item,
          ConditionExpression: "revision = :previous",
          ExpressionAttributeValues: { ":previous": old.revision },
        },
      },
    ];
    if (old.email !== data.email) {
      items.push(
        {
          Delete: {
            TableName: this.table,
            Key: { pk: emailKey(old.email) },
            ConditionExpression: "#owner = :id",
            ExpressionAttributeNames: { "#owner": "owner" },
            ExpressionAttributeValues: { ":id": id },
          },
        },
        {
          Put: {
            TableName: this.table,
            Item: { pk: emailKey(data.email), owner: id },
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
      );
    }
    await this.write(items, old.email === data.email ? -1 : 2);
    return publicItem(item);
  }
  async delete(id) {
    const old = await this.raw(id);
    if (!old) return false;
    await this.write(
      [
        {
          Delete: {
            TableName: this.table,
            Key: { pk: rowKey(id) },
            ConditionExpression: "revision = :previous",
            ExpressionAttributeValues: { ":previous": old.revision },
          },
        },
        {
          Delete: {
            TableName: this.table,
            Key: { pk: emailKey(old.email) },
            ConditionExpression: "#owner = :id",
            ExpressionAttributeNames: { "#owner": "owner" },
            ExpressionAttributeValues: { ":id": id },
          },
        },
      ],
      -1,
    );
    return true;
  }
  async close() {}
}
