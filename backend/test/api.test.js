import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import net from "node:net";
import pg from "pg";
import EmbeddedPostgres from "embedded-postgres";
import request from "supertest";
import { createApp } from "../src/app.js";
import { migrate, loadConfig } from "../src/config.js";
let database, directory, pool, app, agent;
const auth = {
  username: "admin",
  password: "a-test-password-only",
  sessionSecret: "a-test-only-session-secret-32-characters",
};
const record = {
  name: "Alex Rivera",
  email: "alex@example.test",
  department: "Engineering",
  title: "Engineer",
};
before(async () => {
  directory = await mkdtemp(`${tmpdir()}/employee-test-`);
  const port = await new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
  database = new EmbeddedPostgres({
    databaseDir: directory,
    port,
    user: "postgres",
    password: "local-test-only",
    authMethod: "scram-sha-256",
    persistent: false,
    onLog: () => {},
    onError: () => {},
  });
  await database.initialise();
  await database.start();
  await database.createDatabase("employee");
  pool = new pg.Pool({
    host: "127.0.0.1",
    port,
    user: "postgres",
    password: "local-test-only",
    database: "employee",
  });
  await migrate(pool);
  await migrate(pool);
  app = createApp({ pool, auth, version: "test-build" });
  agent = request.agent(app);
  await agent
    .post("/api/login")
    .send({ username: auth.username, password: auth.password })
    .expect(200);
});
after(async () => {
  await pool?.end();
  await database?.stop();
  if (directory) await rm(directory, { recursive: true, force: true });
});
test("health checks the real PostgreSQL connection and reports build version", async () => {
  const res = await request(app).get("/api/health").expect(200);
  assert.deepEqual(res.body, { status: "ok", version: "test-build" });
  assert.equal(res.headers["cache-control"], "no-store, private");
});
test("employee endpoints require authentication", async () => {
  await request(app).get("/api/employees").expect(401);
  await request(app).post("/api/employees").send(record).expect(401);
});
test("login rejects incorrect credentials", async () => {
  await request(app)
    .post("/api/login")
    .send({ username: "admin", password: "wrong" })
    .expect(401);
});
test("session cookie is HttpOnly and SameSite strict", async () => {
  const res = await request(app)
    .post("/api/login")
    .send({ username: auth.username, password: auth.password })
    .expect(200);
  assert.match(res.headers["set-cookie"][0], /HttpOnly/);
  assert.match(res.headers["set-cookie"][0], /SameSite=Strict/);
});
test("production cookies require HTTPS", async () => {
  const secure = createApp({ pool, auth, production: true });
  const res = await request(secure)
    .post("/api/login")
    .send({ username: auth.username, password: auth.password })
    .expect(200);
  assert.match(res.headers["set-cookie"][0], /; Secure/);
});
test("cross-site mutations and form posts are rejected", async () => {
  await agent
    .post("/api/employees")
    .set("Sec-Fetch-Site", "cross-site")
    .send(record)
    .expect(403);
  await request(app)
    .post("/api/login")
    .type("form")
    .send("username=admin&password=wrong")
    .expect(403);
});
test("CRUD persists records, rejects duplicates and handles missing records", async () => {
  const created = await agent.post("/api/employees").send(record).expect(201);
  const id = created.body.id;
  assert.equal(created.body.name, record.name);
  assert.ok(created.body.created_at);
  assert.equal(
    (await pool.query("SELECT count(*) FROM employees WHERE id=$1", [id]))
      .rows[0].count,
    "1",
  );
  await agent.post("/api/employees").send(record).expect(409);
  const list = await agent.get("/api/employees").expect(200);
  assert.equal(list.body.length, 1);
  const edited = await agent
    .put(`/api/employees/${id}`)
    .send({ ...record, title: "Senior Engineer" })
    .expect(200);
  assert.equal(edited.body.title, "Senior Engineer");
  assert.equal(
    (await pool.query("SELECT title FROM employees WHERE id=$1", [id])).rows[0]
      .title,
    "Senior Engineer",
  );
  await agent
    .delete(`/api/employees/${id}`)
    .set("Content-Type", "application/json")
    .expect(204);
  assert.equal(
    (await pool.query("SELECT count(*) FROM employees")).rows[0].count,
    "0",
  );
  await agent.put(`/api/employees/${id}`).send(record).expect(404);
  await agent
    .delete(`/api/employees/${id}`)
    .set("Content-Type", "application/json")
    .expect(404);
});
test("invalid fields, unknown fields and malformed IDs fail validation", async () => {
  await agent
    .post("/api/employees")
    .send({ ...record, email: "invalid" })
    .expect(400);
  await agent
    .post("/api/employees")
    .send({ ...record, isAdmin: true })
    .expect(400);
  await agent.put("/api/employees/not-a-uuid").send(record).expect(400);
});
test("SQL-like input is stored as data and does not damage the table", async () => {
  const res = await agent
    .post("/api/employees")
    .send({
      ...record,
      name: "Robert'); DROP TABLE employees;--",
      email: "sql@example.test",
    })
    .expect(201);
  assert.equal(
    (await pool.query("SELECT name FROM employees WHERE id=$1", [res.body.id]))
      .rows[0].name,
    res.body.name,
  );
  await agent
    .delete(`/api/employees/${res.body.id}`)
    .set("Content-Type", "application/json")
    .expect(204);
});
test("database outage returns unavailable health without leaking details", async () => {
  const failed = createApp({
    pool: {
      query: async () => {
        throw new Error("secret connection details");
      },
    },
    auth,
  });
  const res = await request(failed).get("/api/health").expect(503);
  assert.deepEqual(res.body, { status: "unavailable" });
});
test("fault injection is disabled by default", async () => {
  await agent.post("/api/ops/fault").send({}).expect(404);
});
test("explicitly enabled monitoring fault requires both login and token", async () => {
  const drill = createApp({ pool, auth, faultToken: "authorized-drill" }),
    a = request.agent(drill);
  await a
    .post("/api/login")
    .send({ username: auth.username, password: auth.password });
  await a.post("/api/ops/fault").send({}).expect(404);
  await a
    .post("/api/ops/fault")
    .set("x-fault-token", "authorized-drill")
    .send({})
    .expect(500);
});
test("logout clears the cookie and prevents subsequent access", async () => {
  const a = request.agent(app);
  await a
    .post("/api/login")
    .send({ username: auth.username, password: auth.password });
  await a.post("/api/logout").send({}).expect(204);
  await a.get("/api/employees").expect(401);
});
test("startup fails closed without database/auth configuration", async () => {
  await assert.rejects(() => loadConfig({}), /configuration are required/);
});
