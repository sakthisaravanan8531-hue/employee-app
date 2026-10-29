import EmbeddedPostgres from "embedded-postgres";
import { mkdir, access, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
process.chdir(root);
await mkdir(".local", { recursive: true });
try {
  await access(".env");
} catch {
  await writeFile(
    ".env",
    `DATABASE_URL=postgres://employee:local-db-only@127.0.0.1:5432/employee\nADMIN_USERNAME=admin\nADMIN_PASSWORD=${randomBytes(18).toString("hex")}\nSESSION_SECRET=${randomBytes(32).toString("hex")}\nPORT=8080\nNODE_ENV=development\n`,
    { mode: 0o600, flag: "wx" },
  );
}
const database = new EmbeddedPostgres({
  databaseDir: path.join(root, ".local/postgres"),
  port: 5432,
  user: "employee",
  password: "local-db-only",
  authMethod: "scram-sha-256",
  persistent: true,
  onLog: () => {},
  onError: (message) => console.error(message),
});
try {
  await access(".local/postgres/PG_VERSION");
} catch {
  await database.initialise();
}
await database.start();
const client = database.getPgClient("postgres");
await client.connect();
const result = await client.query(
  "SELECT 1 FROM pg_database WHERE datname='employee'",
);
await client.end();
if (!result.rowCount) await database.createDatabase("employee");
console.log(
  "Local PostgreSQL is running. Local administrator credentials are in the ignored .env file.",
);
const child = spawn("npm", ["run", "dev"], {
  stdio: "inherit",
  detached: true,
});
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
        resolve();
      }, 5000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  await database.stop();
  process.exit(code);
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
child.on("exit", (code) => stop(code || 0));
