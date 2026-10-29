// SQLite is a zero-service local development adapter. AWS uses DynamoDB.
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
export class LocalStore {
  constructor(filename = ":memory:") {
    this.db = new DatabaseSync(filename);
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS employees (id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL UNIQUE,department TEXT NOT NULL,title TEXT NOT NULL,created_at TEXT NOT NULL)`,
    );
  }
  async health() {
    this.db.prepare("SELECT 1").get();
  }
  async list() {
    return this.db
      .prepare("SELECT * FROM employees ORDER BY created_at DESC")
      .all();
  }
  async get(id) {
    return (
      this.db.prepare("SELECT * FROM employees WHERE id=?").get(id) || null
    );
  }
  async create(data) {
    const item = {
      ...data,
      id: randomUUID(),
      created_at: new Date().toISOString(),
    };
    try {
      this.db
        .prepare("INSERT INTO employees VALUES (?,?,?,?,?,?)")
        .run(
          item.id,
          item.name,
          item.email,
          item.department,
          item.title,
          item.created_at,
        );
    } catch (e) {
      if (e.message.includes("UNIQUE"))
        throw Object.assign(new Error("Email already exists"), {
          code: "DUPLICATE",
        });
      throw e;
    }
    return item;
  }
  async update(id, data) {
    const old = await this.get(id);
    if (!old) return null;
    try {
      this.db
        .prepare(
          "UPDATE employees SET name=?,email=?,department=?,title=? WHERE id=?",
        )
        .run(data.name, data.email, data.department, data.title, id);
    } catch (e) {
      if (e.message.includes("UNIQUE"))
        throw Object.assign(new Error("Email already exists"), {
          code: "DUPLICATE",
        });
      throw e;
    }
    return { ...old, ...data };
  }
  async delete(id) {
    return (
      this.db.prepare("DELETE FROM employees WHERE id=?").run(id).changes > 0
    );
  }
  async close() {
    this.db.close();
  }
}
