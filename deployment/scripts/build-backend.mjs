import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const out = path.join(root, ".local/lambda");
await mkdir(out, { recursive: true });
await build({
  entryPoints: [path.join(root, "backend/src/lambda.js")],
  outfile: path.join(out, "index.js"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  minify: false,
  sourcemap: false,
});
let sha = process.env.RELEASE_SHA;
if (!sha) {
  try {
    sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
  } catch {
    sha = "local";
  }
}
if (!/^(?:[0-9a-f]{40}|local)$/.test(sha))
  throw new Error("Invalid release version");
await writeFile(path.join(out, "VERSION"), `${sha}\n`);
console.log("Built Lambda artifact in .local/lambda");
