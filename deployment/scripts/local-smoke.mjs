import assert from "node:assert/strict";
const base = process.env.APP_URL || "http://127.0.0.1:5173";
let cookie = "";
async function call(path, method = "GET", data) {
  const response = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  if (response.headers.getSetCookie().length)
    cookie = response.headers.getSetCookie()[0].split(";")[0];
  const value = response.status === 204 ? null : await response.json();
  assert.ok(response.ok, `${method} ${path}: ${response.status}`);
  return value;
}
assert.match(
  await (await fetch(base + "/employees")).text(),
  /<div id="root"><\/div>/,
);
assert.equal((await call("/api/health")).status, "ok");
await call("/api/login", "POST", {
  username: process.env.ADMIN_USERNAME,
  password: process.env.ADMIN_PASSWORD,
});
const record = {
  name: "Local smoke",
  email: `smoke-${crypto.randomUUID()}@example.test`,
  department: "Validation",
  title: "Temporary",
};
const created = await call("/api/employees", "POST", record);
try {
  assert.ok((await call("/api/employees")).some((e) => e.id === created.id));
  assert.equal(
    (
      await call(`/api/employees/${created.id}`, "PUT", {
        ...record,
        title: "Updated",
      })
    ).title,
    "Updated",
  );
} finally {
  await call(`/api/employees/${created.id}`, "DELETE");
}
await call("/api/logout", "POST", {});
console.log(
  "PASS: frontend SPA, proxied API, login, PostgreSQL CRUD and logout",
);
