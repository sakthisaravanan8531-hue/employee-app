import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { hkdfSync } from "node:crypto";
export async function loadConfig(env = process.env) {
  let auth = {
    username: env.ADMIN_USERNAME || "admin",
    password: env.ADMIN_PASSWORD,
    sessionSecret: env.SESSION_SECRET,
  };
  if (env.AUTH_SECRET_ARN) {
    const result = await new SecretsManagerClient({}).send(
      new GetSecretValueCommand({ SecretId: env.AUTH_SECRET_ARN }),
    );
    auth = JSON.parse(result.SecretString);
    auth.sessionSecret = Buffer.from(
      hkdfSync(
        "sha256",
        auth.password,
        "employee-app",
        "session-signing-v1",
        32,
      ),
    ).toString("hex");
  }
  if (!auth.password || !auth.sessionSecret || auth.sessionSecret.length < 32)
    throw new Error(
      "Authentication configuration is required (session secret: at least 32 characters)",
    );
  let store;
  if (env.TABLE_NAME) {
    const { DynamoStore } = await import("./dynamo-store.js");
    store = new DynamoStore(env.TABLE_NAME);
  } else {
    if (env.NODE_ENV === "production")
      throw new Error("TABLE_NAME is required in production");
    const { LocalStore } = await import("./local-store.js");
    store = new LocalStore(env.LOCAL_DB_PATH || ":memory:");
  }
  return { store, auth };
}
