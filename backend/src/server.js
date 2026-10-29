import { loadConfig, migrate } from "./config.js";
import { createApp } from "./app.js";
const { pool, auth } = await loadConfig();
await migrate(pool);
const app = createApp({
  pool,
  auth,
  production: process.env.NODE_ENV === "production",
  version: process.env.APP_VERSION || "local",
  faultToken: process.env.FAULT_TEST_TOKEN,
});
const server = app.listen(Number(process.env.PORT || 8080), "0.0.0.0", () =>
  console.log("Employee API listening"),
);
async function stop() {
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 25000).unref();
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
