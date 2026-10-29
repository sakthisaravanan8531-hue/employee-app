import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
test("built Lambda handles real API Gateway v2 events, cookies and CRUD", async () => {
  Object.assign(process.env, {
    NODE_ENV: "development",
    TABLE_NAME: "",
    AUTH_SECRET_ARN: "",
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: "test-only-password",
    SESSION_SECRET: "a-test-only-session-signing-secret-32",
    LAMBDA_TASK_ROOT: path.resolve(".local/lambda"),
    LOCAL_DB_PATH: ":memory:",
  });
  const { default: bundle } = await import("../../.local/lambda/index.js");
  let cookie = "";
  async function call(method, url, body, raw = false) {
    const event = {
      version: "2.0",
      routeKey: "$default",
      rawPath: url,
      rawQueryString: "",
      cookies: cookie ? [cookie] : undefined,
      headers: {
        host: "api.example.test",
        "content-type": "application/json",
        "x-forwarded-proto": "https",
      },
      requestContext: {
        requestId: "test",
        stage: "$default",
        http: {
          method,
          path: url,
          protocol: "HTTP/1.1",
          sourceIp: "127.0.0.1",
          userAgent: "test",
        },
      },
      isBase64Encoded: false,
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    };
    const result = await bundle.handler(event, {
      getRemainingTimeInMillis: () => 15000,
    });
    if (result.cookies?.length) cookie = result.cookies[0].split(";")[0];
    return {
      status: result.statusCode,
      cookies: result.cookies,
      data: result.body ? JSON.parse(result.body) : null,
    };
  }
  assert.equal((await call("GET", "/api/health")).data.status, "ok");
  assert.equal((await call("POST", "/api/login", "{", true)).status, 400);
  assert.equal(
    (await call("POST", "/api/login", "x".repeat(17000), true)).status,
    413,
  );
  const login = await call("POST", "/api/login", {
    username: "admin",
    password: "test-only-password",
  });
  assert.equal(login.status, 200);
  assert.match(login.cookies[0], /Secure/);
  const record = {
    name: "Lambda event",
    email: "lambda@example.test",
    department: "Tests",
    title: "Engineer",
  };
  const created = await call("POST", "/api/employees", record);
  assert.equal(created.status, 201);
  assert.equal((await call("GET", "/api/employees")).data.length, 1);
  assert.equal(
    (
      await call("PUT", "/api/employees/" + created.data.id, {
        ...record,
        title: "Lead",
      })
    ).data.title,
    "Lead",
  );
  assert.equal(
    (await call("DELETE", "/api/employees/" + created.data.id)).status,
    204,
  );
  assert.equal((await call("GET", "/api/employees")).data.length, 0);
});
