import { existsSync } from "node:fs";
import { build } from "esbuild";

// Build the pure foundation until the Obsidian entry point is introduced.
const hasPluginEntry = existsSync("src/main.ts");
await build({
  entryPoints: hasPluginEntry
    ? ["src/main.ts"]
    : ["src/domain.ts", "src/defaults.ts", "src/path-policy.ts"],
  ...(hasPluginEntry ? { outfile: "main.js" } : { outdir: "dist" }),
  bundle: true,
  platform: "node",
  target: "es2022",
  format: "cjs",
  external: ["obsidian", "electron"],
  sourcemap: false,
  logLevel: "info",
});
