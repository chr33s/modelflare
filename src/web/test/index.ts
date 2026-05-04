import * as vscode from "vscode";

const EXTENSION_ID = "chr33s.modelflare";
const EXPECTED_BROWSER_ENTRY = "./dist/extension.js";
const EXPECTED_COMMANDS = [
  "modelflare.refreshModels",
  "modelflare.inspectModels",
  "modelflare.storeApiKey",
] as const;
const EXTENSION_LOOKUP_TIMEOUT_MS = 5000;
const EXTENSION_LOOKUP_INTERVAL_MS = 100;

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function waitForExtension(): Promise<vscode.Extension<unknown> | undefined> {
  const deadline = Date.now() + EXTENSION_LOOKUP_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    if (extension) {
      return extension;
    }

    await sleep(EXTENSION_LOOKUP_INTERVAL_MS);
  }

  return vscode.extensions.getExtension(EXTENSION_ID);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

export async function run(): Promise<void> {
  assert(vscode.env.uiKind === vscode.UIKind.Web, "Expected to run inside the web extension host");

  const extension = await waitForExtension();
  assert(extension, `Expected extension ${EXTENSION_ID} to be available in the web host`);
  assert(
    extension.packageJSON?.browser === EXPECTED_BROWSER_ENTRY,
    `Expected browser entry ${EXPECTED_BROWSER_ENTRY}, received ${String(extension.packageJSON?.browser)}`,
  );

  const contributedCommands = Array.isArray(extension.packageJSON?.contributes?.commands)
    ? (extension.packageJSON.contributes.commands as Array<{ command?: unknown }>)
        .map((commandContribution) => commandContribution.command)
        .filter((command): command is string => typeof command === "string")
    : [];

  for (const command of EXPECTED_COMMANDS) {
    assert(
      contributedCommands.includes(command),
      `Expected contributed command ${command} in extension manifest`,
    );
  }

  const vscodeWithLm = vscode as typeof vscode & { lm?: unknown };
  assert(vscodeWithLm.lm, "Expected vscode.lm to be available in the web host");

  if (!extension.isActive) {
    await extension.activate();
  }

  assert(extension.isActive, `Expected extension ${EXTENSION_ID} to activate in the web host`);
}
