import * as vscode from "vscode";
import { bytesToBase64, utf8ByteLength } from "./byte-utils";
import {
  CloudflareModel,
  getCloudflareModelFamily,
  getCloudflareModelHandle,
  getCloudflareModelPriceCategory,
  getCloudflareModelVersion,
  inferCloudflareEditToolHints,
  sortCloudflareModels,
} from "./cloudflare-client";
import { logCloudflareWarning } from "./logging";
import {
  CloudflareAudioContentPart,
  CloudflareChatMessage,
  CloudflareMessageContentPart,
  CloudflareRequestState,
  CloudflareResponsePart,
  CloudflareToolChoiceMode,
  CloudflareToolDefinition,
  requestCloudflareChatResponse,
} from "./cloudflare-runtime";
import { getModelflareConfiguration } from "./config";
import { LANGUAGE_MODEL_VENDOR } from "./provider-identity";
import { normalizeSearchText } from "./value-utils";

interface CloudflareLanguageModelConfigurationProperty {
  readonly type: "string";
  readonly title?: string;
  readonly enum?: readonly string[];
  readonly enumItemLabels?: readonly string[];
  readonly enumDescriptions?: readonly string[];
  readonly default?: string;
  readonly group?: "navigation";
}

interface CloudflareLanguageModelConfigurationSchema {
  readonly properties?: Record<string, CloudflareLanguageModelConfigurationProperty>;
}

interface CloudflareProvideLanguageModelChatResponseOptions
  extends vscode.ProvideLanguageModelChatResponseOptions {
  readonly modelConfiguration?: {
    readonly reasoningEffort?: unknown;
  };
}

interface CloudflareLanguageModelChatCapabilities extends vscode.LanguageModelChatCapabilities {
  readonly editTools?: readonly string[];
}

interface CloudflareLanguageModelChatInformation extends vscode.LanguageModelChatInformation {
  readonly isUserSelectable?: boolean;
  readonly targetChatSessionType?: string;
  readonly configurationSchema?: CloudflareLanguageModelConfigurationSchema;
  readonly capabilities: CloudflareLanguageModelChatCapabilities;
  readonly priceCategory?: string;
}

interface ProviderModelInformation extends CloudflareLanguageModelChatInformation {
  readonly rawMaxInputTokens: number;
  readonly reservedPromptTokens: number;
}

export interface RegisteredModelProvider
  extends vscode.Disposable, vscode.LanguageModelChatProvider<ProviderModelInformation> {
  clearModels(): void;
  updateModels(
    models: CloudflareModel[],
    accountId: string,
    apiKey: string,
    gatewayId?: string,
  ): void;
  getRegisteredModels(): readonly ProviderModelInformation[];
  getRegisteredCatalog(): readonly CloudflareModel[];
}

export interface ProviderRegistrationResult {
  provider: RegisteredModelProvider;
  disposable: vscode.Disposable;
}

const TOOL_CALLING_HINTS = ["function calling", "tool calling", "agent capabilities"];
const IMAGE_INPUT_HINTS = ["vision", "multimodal", "image input", "image understanding"];
const TOOL_CALLING_PROPERTY_HINTS = ["function", "tool"];
const IMAGE_INPUT_PROPERTY_HINTS = ["vision", "image", "multimodal"];
const NEGATIVE_PROPERTY_VALUES = ["false", "0", "no", "disabled", "unsupported"];
const FALLBACK_MAX_INPUT_TOKENS = 8192;
const FALLBACK_MAX_OUTPUT_TOKENS = 4096;
const COMPAT_FALLBACK_MAX_INPUT_TOKENS = 32768;
const COMPAT_FALLBACK_MAX_OUTPUT_TOKENS = 8192;
const BASE_PROMPT_TOKEN_OVERHEAD = 16;
const BASE_COMPLETION_TOKEN_OVERHEAD = 4;
const TOOL_MODE_PROMPT_OVERHEAD = 8;
const BASE_MESSAGE_TOKEN_OVERHEAD = 4;
const BASE_TOOL_CALL_TOKEN_OVERHEAD = 12;
const BASE_TOOL_RESULT_TOKEN_OVERHEAD = 8;
const BASE_TOOL_DEFINITION_TOKEN_OVERHEAD = 16;
const BASE_TOOL_SCHEMA_TOKEN_OVERHEAD = 8;
const TOOL_SCHEMA_TOKEN_MULTIPLIER = 1.1;
const MIN_IMAGE_TOKEN_COST = 64;
const TOKENS_PER_IMAGE_KIB = 64;
const EXPLICIT_INPUT_TOKEN_PROPERTY_HINTS = [
  "max_input_length",
  "max input length",
  "max_input_tokens",
  "max input tokens",
  "input token limit",
  "max_sequence_length",
  "max sequence length",
];
const CONTEXT_WINDOW_PROPERTY_HINTS = [
  "context window",
  "context_window",
  "context length",
  "context_length",
  "context tokens",
];
const OUTPUT_TOKEN_PROPERTY_HINTS = [
  "max_output_tokens",
  "max output tokens",
  "output token limit",
  "max_completion_tokens",
  "max completion tokens",
  "max_new_tokens",
  "completion token limit",
];

interface ResolvedModelTokenLimits {
  readonly rawMaxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly reservedPromptTokens: number;
}

function getModelHandleTokenHints(model: CloudflareModel): number | undefined {
  const modelHandle = getCloudflareModelHandle(model).toLowerCase();
  const explicitMatches = Array.from(modelHandle.matchAll(/(\d+(?:\.\d+)?)\s*([km])/g));
  const explicitParsed = explicitMatches
    .map((match) => parseTokenNumber(`${match[1]}${match[2]}`))
    .filter((candidate): candidate is number => candidate !== undefined);

  if (explicitParsed.length > 0) {
    return Math.max(...explicitParsed);
  }

  if (model.transport !== "compat") {
    return undefined;
  }

  // Compat providers rarely expose context windows in metadata; use conservative family defaults.
  if (modelHandle.includes("claude")) {
    return 200_000;
  }
  if (modelHandle.includes("gemini")) {
    return 1_000_000;
  }
  if (
    modelHandle.includes("gpt-5") ||
    modelHandle.includes("gpt-4") ||
    modelHandle.includes("o1") ||
    modelHandle.includes("o3") ||
    modelHandle.includes("o4")
  ) {
    return 128_000;
  }

  return COMPAT_FALLBACK_MAX_INPUT_TOKENS;
}

function getFallbackMaxInputTokens(model: CloudflareModel): number {
  return model.transport === "compat"
    ? COMPAT_FALLBACK_MAX_INPUT_TOKENS
    : FALLBACK_MAX_INPUT_TOKENS;
}

function getFallbackMaxOutputTokens(model: CloudflareModel, rawMaxInputTokens: number): number {
  const fallbackMaxOutput =
    model.transport === "compat" ? COMPAT_FALLBACK_MAX_OUTPUT_TOKENS : FALLBACK_MAX_OUTPUT_TOKENS;
  return Math.min(fallbackMaxOutput, rawMaxInputTokens);
}

function decodeText(data: Uint8Array): string {
  return new TextDecoder().decode(data);
}

export class UnsupportedDataFormatError extends Error {
  constructor(mimeType?: string) {
    super(
      `Unsupported multimodal data format passed to Cloudflare model: ${mimeType ?? "unknown"}`,
    );
    this.name = "UnsupportedDataFormatError";
  }
}

function toDataPartLike(value: unknown): { data: Uint8Array; mimeType: string } | undefined {
  if (value instanceof vscode.LanguageModelDataPart) {
    return { data: value.data, mimeType: value.mimeType };
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const mimeType = typeof record.mimeType === "string" ? record.mimeType : undefined;
  const rawData = record.data;

  if (!mimeType || rawData === undefined) {
    return undefined;
  }

  if (rawData instanceof Uint8Array) {
    return { data: rawData, mimeType };
  }

  if (Array.isArray(rawData) && rawData.every((item) => typeof item === "number")) {
    return { data: Uint8Array.from(rawData), mimeType };
  }

  throw new UnsupportedDataFormatError(mimeType);
}

function stringifyDataPartLike(value: unknown): string | undefined {
  let dataPart: { data: Uint8Array; mimeType: string } | undefined;
  try {
    dataPart = toDataPartLike(value);
  } catch (err) {
    if (err instanceof UnsupportedDataFormatError) {
      logCloudflareWarning(err.message);
      return undefined;
    }
    throw err;
  }
  if (!dataPart) {
    return undefined;
  }

  if (dataPart.mimeType.startsWith("text/") || dataPart.mimeType.includes("json")) {
    return decodeText(dataPart.data);
  }

  if (dataPart.mimeType.startsWith("image/")) {
    return `[${dataPart.mimeType} ${dataPart.data.byteLength} bytes]`;
  }

  return `[${dataPart.mimeType || "application/octet-stream"} ${dataPart.data.byteLength} bytes]`;
}

function dataPartToBase64(part: vscode.LanguageModelDataPart): string {
  return bytesToBase64(part.data);
}

function toCloudflareAudioFormat(
  mimeType: string,
): CloudflareAudioContentPart["input_audio"]["format"] | undefined {
  const normalizedMimeType = mimeType.split(";", 1)[0]?.trim().toLowerCase();

  switch (normalizedMimeType) {
    case "audio/wav":
    case "audio/wave":
    case "audio/x-wav":
    case "audio/vnd.wave":
      return "wav";
    case "audio/mpeg":
    case "audio/mp3":
      return "mp3";
    default:
      return undefined;
  }
}

function serializeValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function parseTokenNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }

  if (typeof value === "string") {
    const normalized = value.toLowerCase().replace(/(\d),(?=\d)/g, "$1");
    const matches = Array.from(normalized.matchAll(/(\d+(?:\.\d+)?)\s*([km]?)/g));
    const parsed = matches
      .map((match) => {
        const numericValue = Number(match[1]);
        if (!Number.isFinite(numericValue) || numericValue <= 0) {
          return undefined;
        }

        const suffix = match[2];
        const multiplier = suffix === "m" ? 1_000_000 : suffix === "k" ? 1_024 : 1;
        return Math.floor(numericValue * multiplier);
      })
      .filter((candidate): candidate is number => candidate !== undefined);

    return parsed.length > 0 ? Math.max(...parsed) : undefined;
  }

  if (Array.isArray(value)) {
    const parsed = value
      .map((item) => parseTokenNumber(item))
      .filter((candidate): candidate is number => candidate !== undefined);
    return parsed.length > 0 ? Math.max(...parsed) : undefined;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const parsed = [record.maximum, record.max, record.limit, record.default, record.value]
      .map((item) => parseTokenNumber(item))
      .filter((candidate): candidate is number => candidate !== undefined);
    return parsed.length > 0 ? Math.max(...parsed) : undefined;
  }

  return undefined;
}

function findTokenLimitFromProperties(
  model: CloudflareModel,
  propertyHints: readonly string[],
  strategy: "min" | "max" = "max",
): number | undefined {
  if (!model.properties || model.properties.length === 0) {
    return undefined;
  }

  const hints = propertyHints.map((hint) => hint.toLowerCase());
  const candidates = model.properties
    .filter((property) => {
      const propertyId = normalizeSearchText(property.property_id);
      const propertyValue = normalizeSearchText(property.value);
      return hints.some((hint) => propertyId.includes(hint) || propertyValue.includes(hint));
    })
    .map((property) => parseTokenNumber(property.value))
    .filter((candidate): candidate is number => candidate !== undefined);

  if (candidates.length === 0) {
    return undefined;
  }

  return strategy === "min" ? Math.min(...candidates) : Math.max(...candidates);
}

function findTokenLimitFromDescription(
  model: CloudflareModel,
  tokenKind: "input" | "output",
): number | undefined {
  const description = [model.name, model.description, model.task?.description]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase();

  if (description.length === 0) {
    return undefined;
  }

  const regex =
    tokenKind === "input"
      ? /(\d+(?:\.\d+)?)\s*([km]?)\s*(?:token|tokens)?\s*(?:context|window|input)/g
      : /(\d+(?:\.\d+)?)\s*([km]?)\s*(?:token|tokens)?\s*(?:output|completion)/g;
  const matches = Array.from(description.matchAll(regex));
  const parsed = matches
    .map((match) => parseTokenNumber(`${match[1]}${match[2]}`))
    .filter((candidate): candidate is number => candidate !== undefined);

  return parsed.length > 0 ? Math.max(...parsed) : undefined;
}

function resolveModelTokenLimits(
  model: CloudflareModel,
  capabilities: vscode.LanguageModelChatCapabilities,
): ResolvedModelTokenLimits {
  const explicitInputLimit = findTokenLimitFromProperties(
    model,
    EXPLICIT_INPUT_TOKEN_PROPERTY_HINTS,
    "min",
  );
  const contextWindowLimit = findTokenLimitFromProperties(model, CONTEXT_WINDOW_PROPERTY_HINTS);
  const rawMaxInputTokens =
    (explicitInputLimit !== undefined && contextWindowLimit !== undefined
      ? Math.min(explicitInputLimit, contextWindowLimit)
      : (explicitInputLimit ?? contextWindowLimit)) ??
    getModelHandleTokenHints(model) ??
    findTokenLimitFromDescription(model, "input") ??
    getFallbackMaxInputTokens(model);
  const maxOutputTokens =
    findTokenLimitFromProperties(model, OUTPUT_TOKEN_PROPERTY_HINTS) ??
    findTokenLimitFromDescription(model, "output") ??
    model.detectedMaxOutputTokens ??
    getFallbackMaxOutputTokens(model, rawMaxInputTokens);
  const reservedPromptTokens =
    BASE_PROMPT_TOKEN_OVERHEAD +
    BASE_COMPLETION_TOKEN_OVERHEAD +
    (capabilities.toolCalling ? TOOL_MODE_PROMPT_OVERHEAD : 0);

  return {
    rawMaxInputTokens,
    maxOutputTokens,
    reservedPromptTokens,
  };
}

function estimateTextTokens(value: string): number {
  const normalized = value.trim();
  if (normalized.length === 0) {
    return 0;
  }

  const byteCount = utf8ByteLength(normalized);
  const wordCount = normalized.split(/\s+/u).length;
  const punctuationCount = (normalized.match(/[^\w\s]/g) ?? []).length;
  // /3 is more conservative than /4 — better for CJK scripts and emoji-dense text.
  return Math.max(1, Math.ceil(byteCount / 3), wordCount + Math.ceil(punctuationCount / 4));
}

function estimateObjectTokens(value: unknown): number {
  return estimateTextTokens(serializeValue(value));
}

function stringifyDataPart(part: vscode.LanguageModelDataPart): string {
  if (part.mimeType.startsWith("text/") || part.mimeType.includes("json")) {
    return decodeText(part.data);
  }

  if (part.mimeType.startsWith("image/")) {
    return `[${part.mimeType} ${part.data.byteLength} bytes]`;
  }

  return `[${part.mimeType || "application/octet-stream"} ${part.data.byteLength} bytes]`;
}

function estimateToolDefinitionTokens(tool: vscode.LanguageModelChatTool): number {
  const schemaTokens = tool.inputSchema
    ? Math.ceil(estimateObjectTokens(tool.inputSchema) * TOOL_SCHEMA_TOKEN_MULTIPLIER)
    : 0;

  return (
    BASE_TOOL_DEFINITION_TOKEN_OVERHEAD +
    estimateTextTokens(tool.name) +
    estimateTextTokens(tool.description) +
    BASE_TOOL_SCHEMA_TOKEN_OVERHEAD +
    schemaTokens
  );
}

function estimateInputPartTokens(part: unknown): number {
  if (part instanceof vscode.LanguageModelTextPart) {
    return estimateTextTokens(part.value);
  }

  let dataPart: { data: Uint8Array; mimeType: string } | undefined;
  try {
    dataPart = toDataPartLike(part);
  } catch (err) {
    if (err instanceof UnsupportedDataFormatError) {
      dataPart = undefined;
    } else {
      throw err;
    }
  }
  if (dataPart) {
    if (dataPart.mimeType.startsWith("image/")) {
      return Math.max(
        MIN_IMAGE_TOKEN_COST,
        Math.ceil(dataPart.data.byteLength / 1024) * TOKENS_PER_IMAGE_KIB,
      );
    }

    return estimateTextTokens(stringifyDataPartLike(part) ?? "");
  }

  if (part instanceof vscode.LanguageModelToolCallPart) {
    return (
      BASE_TOOL_CALL_TOKEN_OVERHEAD +
      estimateTextTokens(part.name) +
      estimateObjectTokens(part.input)
    );
  }

  if (part instanceof vscode.LanguageModelToolResultPart) {
    return (
      BASE_TOOL_RESULT_TOKEN_OVERHEAD +
      part.content.reduce<number>((total, item) => total + estimateInputPartTokens(item), 0)
    );
  }

  if (typeof part === "string") {
    return estimateTextTokens(part);
  }

  return estimateObjectTokens(part);
}

function estimateMessageTokens(message: vscode.LanguageModelChatRequestMessage): number {
  return (
    BASE_MESSAGE_TOKEN_OVERHEAD +
    (message.name ? estimateTextTokens(message.name) + 1 : 0) +
    message.content.reduce<number>((total, part) => total + estimateInputPartTokens(part), 0)
  );
}

function estimateRequestTokens(
  model: ProviderModelInformation,
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  tools: readonly vscode.LanguageModelChatTool[] | undefined,
): number {
  const messageTokens = messages.reduce(
    (total, message) => total + estimateMessageTokens(message),
    0,
  );
  const toolTokens = (tools ?? []).reduce(
    (total, tool) => total + estimateToolDefinitionTokens(tool),
    0,
  );

  return model.reservedPromptTokens + messageTokens + toolTokens;
}

function collapseContentParts(
  contentParts: readonly CloudflareMessageContentPart[],
): CloudflareChatMessage["content"] {
  if (contentParts.length === 0) {
    return "";
  }

  const mergedParts: CloudflareMessageContentPart[] = [];
  let pendingText = "";

  for (const part of contentParts) {
    if (part.type === "text") {
      pendingText += part.text;
      continue;
    }

    if (pendingText.length > 0) {
      mergedParts.push({ type: "text", text: pendingText });
      pendingText = "";
    }

    mergedParts.push(part);
  }

  if (pendingText.length > 0) {
    mergedParts.push({ type: "text", text: pendingText });
  }

  if (mergedParts.every((part) => part.type === "text")) {
    return mergedParts.map((part) => part.text).join("");
  }

  return mergedParts;
}

function toCloudflareContentParts(
  part: vscode.LanguageModelDataPart,
): CloudflareMessageContentPart[] {
  if (part.mimeType.startsWith("image/")) {
    return [
      {
        type: "image_url",
        image_url: {
          url: `data:${part.mimeType};base64,${dataPartToBase64(part)}`,
        },
      },
    ];
  }

  if (part.mimeType.startsWith("audio/")) {
    const format = toCloudflareAudioFormat(part.mimeType);
    if (!format) {
      throw new UnsupportedDataFormatError(part.mimeType);
    }

    const audioPart: CloudflareAudioContentPart = {
      type: "input_audio",
      input_audio: {
        data: dataPartToBase64(part),
        format,
      },
    };
    return [audioPart];
  }

  const value = stringifyDataPart(part);
  return value.length > 0 ? [{ type: "text", text: value }] : [];
}

function reportResponsePart(
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  part: CloudflareResponsePart,
): void {
  if (part.type === "text") {
    if (part.value.length > 0) {
      progress.report(new vscode.LanguageModelTextPart(part.value));
    }
    return;
  }

  if (part.type === "thinking") {
    reportThinkingPart(progress, part.value);
    return;
  }

  if (part.type === "data") {
    progress.report(new vscode.LanguageModelDataPart(part.data, part.mimeType));
    return;
  }

  progress.report(
    new vscode.LanguageModelToolCallPart(
      part.toolCall.callId,
      part.toolCall.name,
      part.toolCall.input,
    ),
  );
}

function reportThinkingPart(
  progress: vscode.Progress<vscode.LanguageModelResponsePart>,
  value: string,
): void {
  if (value.length === 0) {
    return;
  }

  const ThinkingPartCtor = (
    vscode as { LanguageModelThinkingPart?: new (value: string) => unknown }
  ).LanguageModelThinkingPart;
  if (!ThinkingPartCtor) {
    return;
  }

  progress.report(new ThinkingPartCtor(value) as vscode.LanguageModelResponsePart);
}

function mapRole(role: vscode.LanguageModelChatMessageRole): CloudflareChatMessage["role"] {
  if (role === vscode.LanguageModelChatMessageRole.User) {
    return "user";
  }

  if (role === vscode.LanguageModelChatMessageRole.Assistant) {
    return "assistant";
  }

  return "system";
}

function stringifyUnknownPart(value: unknown): string {
  const dataPartText = stringifyDataPartLike(value);
  if (dataPartText !== undefined) {
    return dataPartText;
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return value.toString();
  }

  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;

    if (typeof record.value === "string") {
      return record.value;
    }

    if (typeof record.text === "string") {
      return record.text;
    }

    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }

  return "";
}

function toCloudflareToolCallPayload(
  part: vscode.LanguageModelToolCallPart,
): NonNullable<CloudflareChatMessage["tool_calls"]>[number] {
  return {
    id: part.callId,
    type: "function",
    function: {
      name: part.name,
      arguments: JSON.stringify(part.input ?? {}),
    },
  };
}

function serializeToolResultContent(part: vscode.LanguageModelToolResultPart): string {
  const content = part.content
    .map((item) => stringifyUnknownPart(item))
    .join("")
    .trim();
  return content.length > 0 ? content : "";
}

export function toCloudflareMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): CloudflareChatMessage[] {
  const cloudflareMessages: CloudflareChatMessage[] = [];

  for (const message of messages) {
    const role = mapRole(message.role);
    const contentParts: CloudflareMessageContentPart[] = [];
    const toolCallParts: vscode.LanguageModelToolCallPart[] = [];
    const toolResultParts: vscode.LanguageModelToolResultPart[] = [];

    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        contentParts.push({ type: "text", text: part.value });
        continue;
      }

      if (part instanceof vscode.LanguageModelToolCallPart) {
        toolCallParts.push(part);
        continue;
      }

      if (part instanceof vscode.LanguageModelToolResultPart) {
        toolResultParts.push(part);
        continue;
      }

      if (part instanceof vscode.LanguageModelDataPart) {
        contentParts.push(...toCloudflareContentParts(part));
        continue;
      }

      if (typeof part === "string") {
        contentParts.push({ type: "text", text: part });
      }
    }

    const content = collapseContentParts(contentParts);
    const hasContent = typeof content === "string" ? content.length > 0 : content.length > 0;

    if (role === "assistant" && toolCallParts.length > 0) {
      cloudflareMessages.push({
        role,
        content,
        tool_calls: toolCallParts.map((part) => toCloudflareToolCallPayload(part)),
      });
    } else if (hasContent) {
      cloudflareMessages.push({
        role,
        content,
      });
    }

    if (role === "user" && toolResultParts.length > 0) {
      for (const part of toolResultParts) {
        cloudflareMessages.push({
          role: "tool",
          tool_call_id: part.callId,
          content: serializeToolResultContent(part),
        });
      }
    }
  }

  return cloudflareMessages;
}

export function toCloudflareTools(
  tools: readonly vscode.LanguageModelChatTool[] | undefined,
): CloudflareToolDefinition[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

export function toCloudflareToolChoice(
  toolMode: vscode.LanguageModelChatToolMode,
  tools: readonly vscode.LanguageModelChatTool[] | undefined,
): CloudflareToolChoiceMode | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  return toolMode === vscode.LanguageModelChatToolMode.Required ? "required" : "auto";
}

function hasNegativePropertyValue(value: string): boolean {
  return NEGATIVE_PROPERTY_VALUES.some((candidate) => value.includes(candidate));
}

function getPropertyCapability(
  model: CloudflareModel,
  propertyHints: readonly string[],
): boolean | undefined {
  if (!model.properties || model.properties.length === 0) {
    return undefined;
  }

  for (const property of model.properties) {
    const propertyId = normalizeSearchText(property.property_id);
    const propertyValue = normalizeSearchText(property.value);
    const matchesHint = propertyHints.some(
      (hint) => propertyId.includes(hint) || propertyValue.includes(hint),
    );

    if (!matchesHint) {
      continue;
    }

    if (hasNegativePropertyValue(propertyValue)) {
      return false;
    }

    return true;
  }

  return undefined;
}

function getModelMetadataText(model: CloudflareModel): string {
  const propertiesText =
    model.properties
      ?.map(
        (property) =>
          `${normalizeSearchText(property.property_id)} ${normalizeSearchText(property.value)}`,
      )
      .join(" ") ?? "";

  return [
    model.id,
    model.name,
    model.description,
    model.task?.id,
    model.task?.name,
    model.task?.description,
    propertiesText,
  ]
    .map((value) => normalizeSearchText(value))
    .join(" ");
}

function hasCapabilityHint(model: CloudflareModel, hints: readonly string[]): boolean {
  const metadata = getModelMetadataText(model);
  return hints.some((hint) => metadata.includes(hint));
}

interface CapabilityResolutionOptions {
  explicitValue?: boolean;
  propertyHints: readonly string[];
  metadataHints: readonly string[];
}

function resolveCapability(model: CloudflareModel, options: CapabilityResolutionOptions): boolean {
  if (options.explicitValue !== undefined) {
    return options.explicitValue;
  }

  return (
    getPropertyCapability(model, options.propertyHints) ??
    hasCapabilityHint(model, options.metadataHints)
  );
}

export function inferCapabilities(model: CloudflareModel): CloudflareLanguageModelChatCapabilities {
  const toolCalling = resolveCapability(model, {
    explicitValue: model.detectedCapabilities?.toolCalling,
    propertyHints: TOOL_CALLING_PROPERTY_HINTS,
    metadataHints: TOOL_CALLING_HINTS,
  });
  const imageInput = resolveCapability(model, {
    explicitValue: model.detectedCapabilities?.imageInput,
    propertyHints: IMAGE_INPUT_PROPERTY_HINTS,
    metadataHints: IMAGE_INPUT_HINTS,
  });
  const editTools = toolCalling ? inferCloudflareEditToolHints(model) : undefined;

  return {
    toolCalling,
    imageInput,
    ...(editTools && editTools.length > 0 ? { editTools } : {}),
  };
}

function toShortModelName(modelHandle: string): string {
  const segments = modelHandle.split("/").filter((segment) => segment.length > 0);
  const lastSegment = segments[segments.length - 1];
  return lastSegment || modelHandle;
}

export function getModelDisplayName(model: CloudflareModel, modelHandle: string): string {
  const name = model.name?.trim();
  if (name && name.startsWith("@")) {
    return toShortModelName(name);
  }

  if (name) {
    return name;
  }

  return modelHandle.startsWith("@") ? toShortModelName(modelHandle) : modelHandle;
}

export function getModelDetail(
  model: CloudflareModel,
  capabilities: vscode.LanguageModelChatCapabilities,
): string | undefined {
  const labels: Array<{ label: string; enabled: boolean | undefined }> = [
    { label: "Tools", enabled: capabilities.toolCalling === true },
    { label: "Vision", enabled: capabilities.imageInput === true },
    { label: "JSON", enabled: model.detectedCapabilities?.structuredOutput },
    { label: "Reasoning", enabled: model.detectedCapabilities?.reasoning },
    { label: "Audio input", enabled: model.detectedCapabilities?.audioInput },
    { label: "Audio output", enabled: model.detectedCapabilities?.audioOutput },
  ];
  const detail = labels.filter((item) => item.enabled).map((item) => item.label);

  return detail.length > 0 ? detail.join(" • ") : undefined;
}

function getReasoningEffortDescription(level: string): string {
  switch (level) {
    case "none":
      return "No reasoning applied";
    case "low":
      return "Faster responses with less reasoning";
    case "medium":
      return "Balanced reasoning and speed";
    case "high":
      return "Greater reasoning depth but slower";
    case "xhigh":
      return "Maximum reasoning depth but slower";
    case "max":
      return "Absolute maximum capability with no constraints";
    default:
      return level;
  }
}

function getReasoningEffortDefault(model: CloudflareModel): string | undefined {
  const levels = model.reasoningEffortLevels ?? [];
  if (levels.length === 0) {
    return undefined;
  }

  const preferred = getCloudflareModelFamily(model).toLowerCase().includes("claude")
    ? "high"
    : "medium";

  return levels.includes(preferred) ? preferred : undefined;
}

function buildReasoningEffortConfigurationSchema(
  model: CloudflareModel,
): CloudflareLanguageModelConfigurationSchema | undefined {
  const levels = model.reasoningEffortLevels ?? [];
  if (levels.length < 2) {
    return undefined;
  }

  return {
    properties: {
      reasoningEffort: {
        type: "string",
        title: "Thinking Effort",
        enum: levels,
        enumItemLabels: levels.map((level) =>
          level.length > 0 ? `${level[0].toUpperCase()}${level.slice(1)}` : level,
        ),
        enumDescriptions: levels.map((level) => getReasoningEffortDescription(level)),
        default: getReasoningEffortDefault(model),
        group: "navigation",
      },
    },
  };
}

function normalizeReasoningEffortValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function supportsReasoningEffortValue(
  model: Pick<CloudflareModel, "reasoningEffortLevels">,
  value: string,
): boolean {
  return !model.reasoningEffortLevels || model.reasoningEffortLevels.includes(value);
}

export function resolveCloudflareReasoningEffort(
  model: Pick<CloudflareModel, "detectedCapabilities" | "reasoningEffortLevels">,
  options: vscode.ProvideLanguageModelChatResponseOptions,
  configuredFallback: string | undefined,
): string | undefined {
  if (!model.detectedCapabilities?.reasoning && !model.reasoningEffortLevels?.length) {
    return undefined;
  }

  const responseOptions = options as CloudflareProvideLanguageModelChatResponseOptions;
  const candidates = [
    responseOptions.modelConfiguration?.reasoningEffort,
    options.modelOptions?.reasoningEffort,
    options.modelOptions?.reasoning_effort,
    configuredFallback,
  ];

  for (const candidate of candidates) {
    const normalized = normalizeReasoningEffortValue(candidate);
    if (normalized && supportsReasoningEffortValue(model, normalized)) {
      return normalized;
    }
  }

  return undefined;
}

function toProviderModelInformation(model: CloudflareModel): ProviderModelInformation {
  const modelHandle = getCloudflareModelHandle(model);
  const capabilities = inferCapabilities(model);
  const tokenLimits = resolveModelTokenLimits(model, capabilities);
  const priceCategory = getCloudflareModelPriceCategory(model);

  return {
    id: modelHandle,
    name: getModelDisplayName(model, modelHandle),
    family: getCloudflareModelFamily(model),
    version: getCloudflareModelVersion(model),
    maxInputTokens: Math.max(256, tokenLimits.rawMaxInputTokens - tokenLimits.reservedPromptTokens),
    maxOutputTokens: tokenLimits.maxOutputTokens,
    capabilities,
    isUserSelectable: true,
    configurationSchema: buildReasoningEffortConfigurationSchema(model),
    tooltip: model.description,
    detail: getModelDetail(model, capabilities),
    rawMaxInputTokens: tokenLimits.rawMaxInputTokens,
    reservedPromptTokens: tokenLimits.reservedPromptTokens,
    ...(priceCategory ? { priceCategory } : {}),
  };
}

class CloudflareModelProvider
  implements vscode.LanguageModelChatProvider<ProviderModelInformation>, RegisteredModelProvider
{
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  private modelInfos: ProviderModelInformation[] = [];
  private modelsById = new Map<string, CloudflareModel>();
  private state: CloudflareRequestState | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  readonly onDidChangeLanguageModelChatInformation = this.onDidChangeEmitter.event;

  updateModels(
    models: CloudflareModel[],
    accountId: string,
    apiKey: string,
    gatewayId?: string,
  ): void {
    const sortedModels = sortCloudflareModels(models);
    this.modelInfos = sortedModels.map(toProviderModelInformation);
    this.modelsById = new Map(
      sortedModels.map((model) => [getCloudflareModelHandle(model), model] as const),
    );
    this.state = { accountId, apiKey, gatewayId };
    this.onDidChangeEmitter.fire();
  }

  clearModels(): void {
    this.modelInfos = [];
    this.modelsById.clear();
    this.state = undefined;
    this.onDidChangeEmitter.fire();
  }

  getRegisteredModels(): readonly ProviderModelInformation[] {
    return this.modelInfos;
  }

  getRegisteredCatalog(): readonly CloudflareModel[] {
    return [...this.modelsById.values()];
  }

  provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken,
  ): ProviderModelInformation[] {
    return this.modelInfos;
  }

  async provideTokenCount(
    _model: ProviderModelInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    if (typeof text === "string") {
      return estimateTextTokens(text);
    }

    return estimateMessageTokens(text);
  }

  async provideLanguageModelChatResponse(
    model: ProviderModelInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    if (token.isCancellationRequested) {
      return;
    }

    if (!this.state) {
      throw new Error("Cloudflare provider is not configured.");
    }

    const cloudflareModel = this.modelsById.get(model.id);
    if (!cloudflareModel) {
      throw new Error(`Cloudflare model is not registered: ${model.id}`);
    }

    const reasoningEffort = resolveCloudflareReasoningEffort(
      cloudflareModel,
      options,
      getModelflareConfiguration().reasoningEffort,
    );

    const estimatedRequestTokens = estimateRequestTokens(model, messages, options.tools);
    if (estimatedRequestTokens > model.rawMaxInputTokens) {
      throw new Error(
        `Cloudflare request exceeds the estimated context window for ${model.name}: ` +
          `${estimatedRequestTokens} tokens requested, ${model.rawMaxInputTokens} available.`,
      );
    }

    const response = await requestCloudflareChatResponse(this.context, {
      modelHandle: getCloudflareModelHandle(cloudflareModel),
      state: this.state,
      messages: toCloudflareMessages(messages),
      reasoningEffort,
      tools: toCloudflareTools(options.tools),
      toolChoice: toCloudflareToolChoice(options.toolMode, options.tools),
      token,
      errorLabel: "model",
      stream: true,
      onTextChunk: (text: string) => {
        if (text.length > 0) {
          progress.report(new vscode.LanguageModelTextPart(text));
        }
      },
      onThinkingChunk: (text: string) => {
        reportThinkingPart(progress, text);
      },
    });

    if (token.isCancellationRequested) {
      return;
    }

    if (!response) {
      return;
    }

    for (const part of response.parts) {
      if (part.type === "text" || part.type === "thinking") {
        continue;
      }

      reportResponsePart(progress, part);
    }
  }

  dispose(): void {
    this.onDidChangeEmitter.dispose();
  }
}

export function registerModelProvider(
  context: vscode.ExtensionContext,
): ProviderRegistrationResult {
  const provider = new CloudflareModelProvider(context);
  const disposable = vscode.lm.registerLanguageModelChatProvider(LANGUAGE_MODEL_VENDOR, provider);
  return { provider, disposable };
}
