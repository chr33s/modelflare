import { defineConfig } from "@vscode/test-cli";

export default defineConfig({
  files: "dist/**/*.test.js",
  extensionDevelopmentPath: ".",
  mocha: {
    ui: "tdd",
    timeout: 20000,
  },
});
