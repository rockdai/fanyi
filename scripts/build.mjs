import { build, context } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

const watch = process.argv.includes("--watch");
const entryPoints = {
  background: "src/background.ts",
  content: "src/content.ts",
  popup: "src/popup.ts",
  options: "src/options.ts",
};

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await cp("public", "dist", { recursive: true });
await cp("popup.html", "dist/popup.html");
await cp("options.html", "dist/options.html");

const buildOptions = {
  entryPoints,
  outdir: "dist",
  bundle: true,
  minify: !watch,
  sourcemap: watch,
  target: "chrome114",
  format: "iife",
  logLevel: "info",
};

if (watch) {
  const buildContext = await context(buildOptions);
  await buildContext.watch();
  console.log("Watching extension sources...");
} else {
  await build(buildOptions);
}
