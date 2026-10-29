import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import { rateLimit } from "express-rate-limit";
import { randomUUID, timingSafeEqual, createHash } from "node:crypto";
import { z } from "zod";
const employee = z
  .object({
    name: z.string().trim().min(1).max(120),
    email: z
      .email()
      .max(254)
      .transform((v) => v.toLowerCase()),
    department: z.string().trim().min(1).max(100),
    title: z.string().trim().min(1).max(120),
  })
  .strict();
const idSchema = z.uuid();
const equal = (a, b) =>
  timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );
export function createApp({
  pool,
  auth,
  production = false,
  version = "local",
  faultToken,
}) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use((req, res, next) => {
    res.set("Cache-Control", "no-store, private");
    next();
  });
  app.use(helmet(), express.json({ limit: "16kb" }), cookieParser());
  app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () =>
      console.log(
        JSON.stringify({
          method: req.method,
          path: req.originalUrl.split("?")[0],
          status: res.statusCode,
          durationMs: Date.now() - start,
        }),
      ),
    );
    next();
  });
  const cookie = {
    httpOnly: true,
    secure: production,
    sameSite: "strict",
    path: "/api",
    maxAge: 8 * 60 * 60 * 1000,
  };
  // Same-origin JSON requests prevent cross-site mutations, including login CSRF.
  app.use("/api", (req, res, next) => {
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      (req.get("content-type")?.split(";")[0].trim().toLowerCase() !==
        "application/json" ||
        req.get("sec-fetch-site") === "cross-site")
    )
      return res
        .status(403)
        .json({ error: "Same-origin JSON request required" });
    next();
  });
  app.get("/api/health", async (req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ status: "ok", version });
    } catch {
      res.status(503).json({ status: "unavailable" });
    }
  });
  app.post(
    "/api/login",
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 20,
      standardHeaders: "draft-8",
      legacyHeaders: false,
    }),
    (req, res) => {
      const parsed = z
        .object({
          username: z.string().max(100),
          password: z.string().max(512),
        })
        .safeParse(req.body);
      if (
        !parsed.success ||
        !equal(parsed.data.username, auth.username) ||
        !equal(parsed.data.password, auth.password)
      )
        return res.status(401).json({ error: "Invalid username or password" });
      const token = jwt.sign({ sub: auth.username }, auth.sessionSecret, {
        algorithm: "HS256",
        expiresIn: "8h",
        issuer: "employee-app",
        audience: "employee-web",
      });
      res.cookie("session", token, cookie).json({ username: auth.username });
    },
  );
  app.post("/api/logout", (req, res) => {
    const { maxAge, ...options } = cookie;
    res.clearCookie("session", options).status(204).end();
  });
  app.use("/api", (req, res, next) => {
    try {
      req.user = jwt.verify(req.cookies.session, auth.sessionSecret, {
        algorithms: ["HS256"],
        issuer: "employee-app",
        audience: "employee-web",
      });
      next();
    } catch {
      res.status(401).json({ error: "Please sign in" });
    }
  });
  app.get("/api/me", (req, res) => res.json({ username: req.user.sub }));
  app.get("/api/employees", async (req, res) => {
    const result = await pool.query(
      "SELECT * FROM employees ORDER BY created_at DESC",
    );
    res.json(result.rows);
  });
  app.post("/api/employees", async (req, res) => {
    const data = employee.parse(req.body);
    const result = await pool.query(
      "INSERT INTO employees (id,name,email,department,title) VALUES ($1,$2,$3,$4,$5) RETURNING *",
      [randomUUID(), data.name, data.email, data.department, data.title],
    );
    res.status(201).json(result.rows[0]);
  });
  app.put("/api/employees/:id", async (req, res) => {
    const id = idSchema.parse(req.params.id),
      data = employee.parse(req.body);
    const result = await pool.query(
      "UPDATE employees SET name=$1,email=$2,department=$3,title=$4 WHERE id=$5 RETURNING *",
      [data.name, data.email, data.department, data.title, id],
    );
    if (!result.rowCount)
      return res.status(404).json({ error: "Employee not found" });
    res.json(result.rows[0]);
  });
  app.delete("/api/employees/:id", async (req, res) => {
    const result = await pool.query("DELETE FROM employees WHERE id=$1", [
      idSchema.parse(req.params.id),
    ]);
    if (!result.rowCount)
      return res.status(404).json({ error: "Employee not found" });
    res.status(204).end();
  });
  // Disabled by default. Temporarily supply a token via SSM for an authorized alarm drill.
  app.post("/api/ops/fault", (req, res) => {
    if (!faultToken || !equal(req.get("x-fault-token") || "", faultToken))
      return res.status(404).json({ error: "Not found" });
    res.status(500).json({ error: "Controlled monitoring drill" });
  });
  app.use((req, res) => res.status(404).json({ error: "Not found" }));
  app.use((error, req, res, next) => {
    if (error instanceof z.ZodError)
      return res
        .status(400)
        .json({
          error: "Invalid input",
          fields: error.issues.map((i) => i.path.join(".")),
        });
    if (error.code === "23505")
      return res.status(409).json({ error: "Email already exists" });
    if (error.type === "entity.parse.failed")
      return res.status(400).json({ error: "Invalid JSON" });
    if (error.status === 413)
      return res.status(413).json({ error: "Request too large" });
    console.error(
      JSON.stringify({
        event: "request_error",
        code: error.code || "internal",
      }),
    );
    res.status(500).json({ error: "Internal server error" });
  });
  return app;
}
