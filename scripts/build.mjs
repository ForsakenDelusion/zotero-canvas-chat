import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { basename, resolve } from "node:path";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(root, "dist");
const addon = resolve(output, "addon");
const canvas = resolve(addon, "content/canvas");
const manifest = await readFile(resolve(root, "addon/manifest.json"), "utf8");
const { version, applications: { zotero } } = JSON.parse(manifest);
const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
if (pkg.version !== version) throw new Error("package.json and add-on manifest versions must match");

await rm(addon, { recursive: true, force: true });
await mkdir(canvas, { recursive: true });
await writeFile(resolve(addon, "manifest.json"), manifest);
await copyFile(resolve(root, "addon/bootstrap.js"), resolve(addon, "bootstrap.js"));
await copyFile(resolve(root, "LICENSE"), resolve(addon, "LICENSE"));

const options = { absWorkingDir: root, bundle: true, target: "firefox115", format: "iife", metafile: true };
const [host, ui] = await Promise.all([
  build({ ...options, entryPoints: ["src/index.ts"], outfile: resolve(addon, "content/host.js"), globalName: "CanvasPlugin" }),
  build({
    ...options, entryPoints: ["ui/main.tsx"], outfile: resolve(canvas, "canvas.js"), jsx: "automatic", minify: true, write: false,
    loader: { ".woff2": "dataurl", ".woff": "dataurl", ".ttf": "dataurl" },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" },
  }),
]);
const html = await readFile(resolve(root, "ui/index.html"), "utf8");
const script = ui.outputFiles.find((file) => file.path.endsWith("canvas.js")).text.replace(/<\/script/gi, "<\\/script");
const style = ui.outputFiles.find((file) => file.path.endsWith("canvas.css")).text.replace(/<\/style/gi, "<\\/style");
const hash = createHash("sha256").update(script).digest("base64");
const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; font-src data:; img-src data:; form-action 'none'">`;
await writeFile(resolve(canvas, "index.html"), html
  .replace('<script type="module" src="/main.tsx"></script>', () => `<script>${script}</script>`)
  .replace("</head>", () => `${policy}<style>${style}</style></head>`));

const bundledPackages = new Set();
for (const result of [host, ui]) {
  for (const output of Object.values(result.metafile.outputs)) {
    for (const [input, { bytesInOutput }] of Object.entries(output.inputs)) {
      if (!bytesInOutput) continue;
      const packagePath = input.match(/^(.*\bnode_modules\/(?:@[^/]+\/)?[^/]+)\//)?.[1];
      if (packagePath) bundledPackages.add(packagePath);
    }
  }
}
const notices = await Promise.all([...bundledPackages].sort().map(async (packagePath) => {
  const directory = resolve(root, packagePath);
  const { name, version, license } = JSON.parse(await readFile(resolve(directory, "package.json"), "utf8"));
  const files = (await readdir(directory)).filter((file) => /^(licen[cs]e|copying|notice|ofl)([.-]|$)/i.test(file)).sort();
  const texts = await Promise.all(files.map((file) => readFile(resolve(directory, file), "utf8")));
  if (!texts.length && ["rehype-katex", "remark-math"].includes(name)) {
    texts.push(await readFile(resolve(root, "licenses/remark-math.txt"), "utf8"));
  }
  if (!texts.length) throw new Error(`Missing license notice for ${name}@${version}`);
  return `${name}@${version} (${license})\n\n${texts.map((text) => text.trim()).join("\n\n")}`;
}));
await writeFile(resolve(addon, "THIRD-PARTY-NOTICES.txt"), notices.join("\n\n--------\n\n") + "\n");

const xpi = resolve(output, `zotero-canvas-chat-${version}.xpi`);
await rm(xpi, { force: true });
execFileSync("zip", ["-Xqr", xpi, "."], { cwd: addon });
const updateLink = new URL(`../../download/v${version}/${basename(xpi)}`, zotero.update_url).href;
const updateHash = createHash("sha256").update(await readFile(xpi)).digest("hex");
const update = {
  version,
  update_link: updateLink,
  update_hash: `sha256:${updateHash}`,
  applications: {
    zotero: { strict_min_version: zotero.strict_min_version, strict_max_version: zotero.strict_max_version },
  },
};
await writeFile(resolve(output, "updates.json"), JSON.stringify({
  addons: { [zotero.id]: { updates: [update] } },
}, null, 2) + "\n");
console.log(xpi);
