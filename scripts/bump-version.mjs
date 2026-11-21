import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const version = process.argv[2]?.trim();
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("Usage: npm run version:bump -- <major.minor.patch>");
  process.exit(1);
}

const root = fileURLToPath(new URL("../", import.meta.url));

async function updateJson(relativePath) {
  const fullPath = resolve(root, relativePath);
  const data = JSON.parse(await readFile(fullPath, "utf8"));
  data.version = version;
  await writeFile(fullPath, JSON.stringify(data, null, 2) + "\n");
}

await updateJson("package.json");
await updateJson("addon/manifest.json");
execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], {
  cwd: root,
  stdio: "inherit",
});
console.log(`Bumped version to ${version}`);
