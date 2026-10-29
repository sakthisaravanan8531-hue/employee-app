import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { readFileSync } from "node:fs";
import pg from "pg";
export async function loadConfig(env = process.env) {
  let database = env.DATABASE_URL;
  let auth = {
    username: env.ADMIN_USERNAME || "admin",
    password: env.ADMIN_PASSWORD,
    sessionSecret: env.SESSION_SECRET,
  };
  const client = new SecretsManagerClient({});
  async function secret(id) {
    const result = await client.send(
      new GetSecretValueCommand({ SecretId: id }),
    );
    return JSON.parse(result.SecretString);
  }
  if (env.DB_SECRET_ARN) {
    const db = await secret(env.DB_SECRET_ARN);
    database = {
      host: env.DB_HOST,
      port: Number(env.DB_PORT || 5432),
      database: env.DB_NAME || "employee",
      user: db.username,
      password: db.password,
      ssl: {
        rejectUnauthorized: true,
        ca: readFileSync(env.RDS_CA_PATH || "/opt/employee/rds-ca.pem", "utf8"),
      },
    };
  }
  if (env.AUTH_SECRET_ARN) auth = await secret(env.AUTH_SECRET_ARN);
  if (env.SESSION_SECRET_ARN) {
    const result = await client.send(
      new GetSecretValueCommand({ SecretId: env.SESSION_SECRET_ARN }),
    );
    auth.sessionSecret = result.SecretString;
  }
  if (
    !database ||
    !auth.password ||
    !auth.sessionSecret ||
    auth.sessionSecret.length < 32
  )
    throw new Error(
      "Database and authentication configuration are required (session secret: at least 32 characters)",
    );
  return {
    pool: new pg.Pool(
      typeof database === "string" ? { connectionString: database } : database,
    ),
    auth,
  };
}
export async function migrate(pool) {
  // A transaction-scoped lock makes concurrent ASG startup safe.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(5842901)");
    await client.query(`CREATE TABLE IF NOT EXISTS employees (
      id UUID PRIMARY KEY, name VARCHAR(120) NOT NULL, email VARCHAR(254) NOT NULL UNIQUE,
      department VARCHAR(100) NOT NULL, title VARCHAR(120) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
