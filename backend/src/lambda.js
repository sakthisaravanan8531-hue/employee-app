import serverless from "serverless-http";
import { readFileSync } from "node:fs";
import { loadConfig } from "./config.js";
import { createApp } from "./app.js";
let cached,
  loadedAt = 0;
export async function handler(event, context) {
  // Refresh credentials every five minutes; transient load failures remain retryable.
  if (!cached || Date.now() - loadedAt > 300000) {
    const { store, auth } = await loadConfig();
    const version = readFileSync(
      `${process.env.LAMBDA_TASK_ROOT || process.cwd()}/VERSION`,
      "utf8",
    ).trim();
    cached = serverless(
      createApp({
        store,
        auth,
        production: true,
        version,
        faultToken: process.env.FAULT_TEST_TOKEN,
      }),
    );
    loadedAt = Date.now();
  }
  const response = await cached(event, context);
  // Normalize single Set-Cookie headers into API Gateway v2's cookie array.
  if (event.version === "2.0") {
    for (const key of Object.keys(response.headers || {})) {
      if (key.toLowerCase() === "set-cookie") {
        const value = response.headers[key];
        response.cookies = [
          ...(response.cookies || []),
          ...(Array.isArray(value) ? value : [value]),
        ];
        delete response.headers[key];
      }
    }
  }
  return response;
}
