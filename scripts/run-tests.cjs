#!/usr/bin/env node
// 用 esbuild 把 TS 测试打包成临时 ESM，再交给 node:test 运行（无需额外依赖）。
const { build } = require("esbuild");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

async function main() {
  const root = path.resolve(__dirname, "..");
  const testFiles = ["src/domain/fittingRecord.test.ts", "src/domain/chain.test.ts"]
    .map((p) => path.join(root, p))
    .filter(fs.existsSync);

  const entry = path.join(os.tmpdir(), `fitting-tests-entry-${process.pid}.ts`);
  fs.writeFileSync(
    entry,
    testFiles.map((f) => `import ${JSON.stringify(f)};`).join("\n"),
  );
  const out = path.join(os.tmpdir(), `fitting-tests-${process.pid}.mjs`);
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outfile: out,
    logLevel: "warning",
  });

  const res = spawnSync(process.execPath, ["--test", out], { stdio: "inherit" });
  fs.rmSync(out, { force: true });
  fs.rmSync(entry, { force: true });
  process.exit(res.status ?? 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
