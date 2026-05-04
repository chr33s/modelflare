import * as vscode from "vscode";
import { formatUnknownErrorMessage } from "./value-utils";

const OUTPUT_CHANNEL_NAME = "Cloudflare Copilot Models";

let outputChannel: vscode.OutputChannel | undefined;

function withOutputChannel(action: (channel: vscode.OutputChannel) => void): void {
  try {
    outputChannel ??= vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
    action(outputChannel);
  } catch {
    // Ignore logging failures in non-extension test contexts.
  }
}

export function appendCloudflareLogLine(message: string): void {
  withOutputChannel((channel) => channel.appendLine(message));
}

export function clearCloudflareOutputChannel(): void {
  withOutputChannel((channel) => channel.clear());
}

export function showCloudflareOutputChannel(preserveFocus?: boolean): void {
  withOutputChannel((channel) => channel.show(preserveFocus));
}

export function logCloudflareWarning(message: string, error?: unknown): void {
  appendCloudflareLogLine(
    `[warn] ${message}${error === undefined ? "" : `: ${formatUnknownErrorMessage(error)}`}`,
  );
}

export function logCloudflareError(message: string, error?: unknown): void {
  appendCloudflareLogLine(
    `[error] ${message}${error === undefined ? "" : `: ${formatUnknownErrorMessage(error)}`}`,
  );
}

export function disposeCloudflareOutputChannel(): void {
  if (outputChannel) {
    outputChannel.dispose();
    outputChannel = undefined;
  }
}
