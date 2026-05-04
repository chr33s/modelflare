import * as vscode from "vscode";
import type { CloudflareDetectedCapabilities } from "./cloudflare-model-capabilities";
import { normalizeCloudflareModelFilter, TEXT_GENERATION_MODEL_FILTER } from "./model-filter";

export const DEFAULT_MODEL_FILTER = TEXT_GENERATION_MODEL_FILTER;
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

export interface ModelflareConfiguration {
  readonly accountId?: string;
  readonly apiKey?: string;
  readonly gatewayId?: string;
  readonly modelFilter: string;
  readonly includeGatewaySupportedModels: boolean;
  readonly gatewaySupportedModelProviders: readonly string[];
  readonly manualModels: readonly unknown[];
  readonly completionModel?: string;
  readonly reasoningEffort?: string;
  readonly completionSystemPrompt: string;
  readonly completionExcludedLanguages: readonly string[];
  readonly capabilityOverrides: Record<string, Partial<CloudflareDetectedCapabilities>>;
}

export function getModelflareConfiguration(): ModelflareConfiguration {
  const configuration = vscode.workspace.getConfiguration("modelflare");

  return {
    accountId: configuration.get<string>("accountId")?.trim() || undefined,
    apiKey: configuration.get<string>("apiKey")?.trim() || undefined,
    gatewayId: configuration.get<string>("gatewayId")?.trim() || undefined,
    modelFilter: normalizeCloudflareModelFilter(
      configuration.get<string>("modelFilter") ?? DEFAULT_MODEL_FILTER,
    ),
    includeGatewaySupportedModels:
      configuration.get<boolean>("includeGatewaySupportedModels") ??
      DEFAULT_INCLUDE_GATEWAY_SUPPORTED_MODELS,
    gatewaySupportedModelProviders:
      configuration.get<string[]>("gatewaySupportedModelProviders") ?? [],
    manualModels: configuration.get<unknown[]>("manualModels") ?? [],
    completionModel: configuration.get<string>("completionModel")?.trim() || undefined,
    reasoningEffort: configuration.get<string>("reasoningEffort")?.trim() || undefined,
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
    getModelflareConfiguration()
      .completionExcludedLanguages.map((languageId) => languageId.trim())
      .filter((languageId) => languageId.length > 0),
  );
}
