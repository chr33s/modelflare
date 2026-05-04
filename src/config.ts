import * as vscode from "vscode";
import type { CloudflareDetectedCapabilities } from "./cloudflare-model-capabilities";

export const DEFAULT_MODEL_FILTER = "Text Generation";
export const DEFAULT_INCLUDE_GATEWAY_SUPPORTED_MODELS = true;
export const DEFAULT_COMPLETION_SYSTEM_PROMPT =
  "You are a precise code completion engine. Return only the completion with no markdown or explanation.";
export const DEFAULT_COMPLETION_EXCLUDED_LANGUAGE_IDS = [
  "plaintext",
  "markdown",
  "json",
  "jsonc",
  "log",
] as const;

export interface CloudflareCopilotConfiguration {
  readonly accountId?: string;
  readonly apiKey?: string;
  readonly gatewayId?: string;
  readonly modelFilter: string;
  readonly includeGatewaySupportedModels: boolean;
  readonly gatewaySupportedModelProviders: readonly string[];
  readonly manualModels: readonly unknown[];
  readonly completionModel?: string;
  readonly completionSystemPrompt: string;
  readonly completionExcludedLanguages: readonly string[];
  readonly capabilityOverrides: Record<string, Partial<CloudflareDetectedCapabilities>>;
}

export function getCloudflareCopilotConfiguration(): CloudflareCopilotConfiguration {
  const configuration = vscode.workspace.getConfiguration("cloudflareCopilot");

  return {
    accountId: configuration.get<string>("accountId")?.trim() || undefined,
    apiKey: configuration.get<string>("apiKey")?.trim() || undefined,
    gatewayId: configuration.get<string>("gatewayId")?.trim() || undefined,
    modelFilter: configuration.get<string>("modelFilter") ?? DEFAULT_MODEL_FILTER,
    includeGatewaySupportedModels:
      configuration.get<boolean>("includeGatewaySupportedModels") ??
      DEFAULT_INCLUDE_GATEWAY_SUPPORTED_MODELS,
    gatewaySupportedModelProviders:
      configuration.get<string[]>("gatewaySupportedModelProviders") ?? [],
    manualModels: configuration.get<unknown[]>("manualModels") ?? [],
    completionModel: configuration.get<string>("completionModel")?.trim() || undefined,
    completionSystemPrompt:
      configuration.get<string>("completionSystemPrompt")?.trim() ||
      DEFAULT_COMPLETION_SYSTEM_PROMPT,
    completionExcludedLanguages: configuration.get<string[]>("completionExcludedLanguages") ?? [
      ...DEFAULT_COMPLETION_EXCLUDED_LANGUAGE_IDS,
    ],
    capabilityOverrides:
      configuration.get<Record<string, Partial<CloudflareDetectedCapabilities>>>(
        "capabilityOverrides",
      ) ?? {},
  };
}

export function getCompletionExcludedLanguageSet(): ReadonlySet<string> {
  return new Set(
    getCloudflareCopilotConfiguration()
      .completionExcludedLanguages.map((languageId) => languageId.trim())
      .filter((languageId) => languageId.length > 0),
  );
}
