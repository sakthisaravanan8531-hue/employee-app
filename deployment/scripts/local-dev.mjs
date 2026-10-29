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
    `LOCAL_DB_PATH=../.local/employees.sqlite\nADMIN_USERNAME=admin\nADMIN_PASSWORD=${randomBytes(18).toString("hex")}\nSESSION_SECRET=${randomBytes(32).toString("hex")}\nPORT=8080\nNODE_ENV=development\n`,
    { mode: 0o600, flag: "wx" },
  );
}
console.log(
  "Local SQLite storage is ready. Administrator credentials are in the ignored .env file.",
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
  process.exit(code);
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
child.on("exit", (code) => stop(code || 0));
