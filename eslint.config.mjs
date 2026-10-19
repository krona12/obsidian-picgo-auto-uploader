import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "main.js",
      "main.js.map",
      "dist/**",
      "release/**",
      ".release-stage-*/**",
      ".release-backup-*/**",
      "coverage/**",
      ".superpowers/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly" } },
  },
);
