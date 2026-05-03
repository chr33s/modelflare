/// <reference types="node" />

import * as esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

async function main(): Promise<void> {
  const context = await esbuild.context({
    entryPoints: [
      { in: "src/extension.ts", out: "extension" },
      { in: "src/web/test/index.ts", out: "web/test/index" },
    ],
    bundle: true,
    external: ["vscode"],
    format: "cjs",
    logLevel: "info",
    mainFields: ["browser", "module", "main"],
    minify: production,
    outdir: "dist",
    platform: "browser",
    sourcemap: production ? false : true,
    sourcesContent: false,
    target: ["es2020"],
    define: {
      global: "globalThis",
    },
  });

  if (watch) {
    await context.watch();
    return;
  }

  await context.rebuild();
  await context.dispose();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
