/// <reference types="node" />

import path from "node:path";
import { fileURLToPath } from "node:url";
import { runTests, type BrowserType } from "@vscode/test-web";

const currentFilePath = fileURLToPath(import.meta.url);
const workspaceRoot = path.dirname(currentFilePath);
const supportedBrowserTypes = [
  "chromium",
  "firefox",
  "webkit",
  "none",
] as const satisfies readonly BrowserType[];

function isBrowserType(value: string): value is BrowserType {
  return (supportedBrowserTypes as readonly string[]).includes(value);
}

function getBrowserType(): BrowserType {
  const configuredBrowserType = process.env.VSCODE_TEST_WEB_BROWSER;
  if (configuredBrowserType && isBrowserType(configuredBrowserType)) {
    return configuredBrowserType;
  }

  return "chromium";
}

async function main(): Promise<void> {
  await runTests({
    browserType: getBrowserType(),
    extensionDevelopmentPath: workspaceRoot,
    extensionTestsPath: path.join(workspaceRoot, "dist", "web", "test", "index.js"),
    folderPath: workspaceRoot,
    headless: true,
    quality: "stable",
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
