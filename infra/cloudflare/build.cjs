const path = require("node:path");
const { buildSync } = require("esbuild");

exports.bundle = function bundle() {
  return buildSync({
    absWorkingDir: __dirname,
    entryPoints: ["worker/index.mjs"],
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    write: false,
    minify: true,
  }).outputFiles[0].text;
};

if (require.main === module) {
  const fs = require("node:fs");
  fs.mkdirSync(path.join(__dirname, "dist"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "dist/worker.mjs"), exports.bundle());
}
