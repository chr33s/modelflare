import {
  detectCloudflareCapabilitiesFromSchema,
  detectCloudflareReasoningEffortLevelsFromSchema,
  readManualCloudflareModelCapabilities,
  type CloudflareDetectedCapabilities,
} from "./cloudflare-model-capabilities";
import {
  ALL_MODEL_FILTER,
  getAiGatewayModelFilter,
  normalizeCloudflareModelFilter,
  TEXT_GENERATION_MODEL_FILTER,
  TEXT_GENERATION_TASK_NAME,
} from "./model-filter";
import { getObjectRecord, normalizeSearchText, parseJson } from "./value-utils";

export interface CloudflareModel {
  id: string; // Cloudflare internal model UUID
  name?: string;
  description?: string;
  source?: CloudflareModelSource;
  transport?: CloudflareModelTransport;
  provider?: {
    id: string;
    name?: string;
  };
  task?: {
    id: string;
    name?: string; // e.g. "Text Generation"
    description?: string;
  };
  properties?: Array<{ property_id: string; value: unknown }>;
  detectedCapabilities?: CloudflareDetectedCapabilities;
  reasoningEffortLevels?: readonly string[];
}

export interface CloudflareModelPickerCategory {
  label: string;
  order: number;
}

export type CloudflareModelSource = "workers-ai" | "ai-gateway" | "manual";
export type CloudflareModelTransport = "direct" | "compat";

export interface ManualCloudflareModelConfig {
  model: string;
  name?: string;
  description?: string;
  task?: string;
  capabilities?: Partial<CloudflareDetectedCapabilities>;
  reasoningEffortLevels?: readonly string[];
}

interface CloudflareModelsResponse {
  success: boolean;
  result: CloudflareModel[];
  errors: Array<{ message: string }>;
  result_info?: {
    page?: number;
    per_page?: number;
    total_pages?: number;
    count?: number;
    total_count?: number;
  };
}

const AI_GATEWAY_SUPPORTED_MODELS_URL =
  "https://developers.cloudflare.com/ai-gateway/supported-models/index.md";
const SCHEMA_BATCH_SIZE = 5;
const MODEL_SEARCH_PAGE_SIZE = 100;
const MAX_MODEL_SEARCH_PAGES = 20;
const MAX_NORMALIZED_TEXT_LENGTH = 4096;
const EXPERIMENTAL_MODEL_HINTS = ["experimental", "preview", "beta", "alpha"];
const COMPLETION_MODEL_HINTS = ["code", "coder", "completion", "autocomplete"];
const COMPLETION_CHAT_HINTS = ["instruct", "chat"];
const COMPLETION_FAST_HINTS = ["fast", "turbo", "instant", "mini", "small"];
const COMPLETION_SLOW_HINTS = ["vision", "reasoning", "thinking", "audio"];
const FAMILY_SUFFIX_HINTS = new Set([
  "audio",
  "base",
  "beta",
  "chat",
  "distill",
  "experimental",
  "fast",
  "fp8",
  "hf",
  "instruct",
  "instant",
  "it",
  "large",
  "lite",
  "medium",
  "mini",
  "preview",
  "reasoning",
  "small",
  "turbo",
  "vision",
]);
const DISPLAY_LABEL_OVERRIDES = new Map<string, string>([
  ["ai", "AI"],
  ["anthropic", "Anthropic"],
  ["google-ai-studio", "Google AI Studio"],
  ["grok", "Grok"],
  ["openai", "OpenAI"],
  ["openrouter", "OpenRouter"],
  ["workers-ai", "Workers AI"],
  ["xai", "xAI"],
]);
const GATEWAY_TEXT_EMBEDDING_HINTS = ["embed", "embedding"];
const GATEWAY_AUDIO_INPUT_HINTS = ["transcribe", "whisper", "speech-to-text", "asr"];
const GATEWAY_AUDIO_OUTPUT_HINTS = ["tts", "text-to-speech", "speech-"];
const GATEWAY_IMAGE_HINTS = [
  "image",
  "imagen",
  "recraft",
  "flux",
  "stable-diffusion",
  "nano-banana",
  "seedream",
  "ideogram",
];
const GATEWAY_VIDEO_HINTS = [
  "video",
  "veo",
  "hailuo",
  "pixverse",
  "vidu",
  "minimax-video",
  "seedance",
];
const GATEWAY_MUSIC_HINTS = ["music"];
const GATEWAY_REASONING_HINTS = [
  "reason",
  "thinking",
  "o1",
  "o3",
  "o4",
  "gpt-5",
  "claude",
  "gemini-2.5",
  "grok-4",
  "r1",
  "opus",
];
const COMPAT_REASONING_EFFORT_LEVELS = ["low", "medium", "high"] as const;
const GATEWAY_VISION_HINTS = [
  "vision",
  "multimodal",
  "gpt-4o",
  "gpt-5",
  "claude",
  "gemini",
  "grok",
  "pixtral",
  "qwen-vl",
  "llama-4",
];

function inferModelProviderFromHandle(
  modelHandle: string,
): CloudflareModel["provider"] | undefined {
  const trimmedHandle = modelHandle.trim();
  const segments = trimmedHandle.split("/").filter((segment) => segment.length > 0);

  if (trimmedHandle.startsWith("@") && segments.length >= 3) {
    const providerId = segments[1]?.toLowerCase();
    if (!providerId) {
      return undefined;
    }

    return {
      id: providerId,
      name: DISPLAY_LABEL_OVERRIDES.get(providerId) ?? toDisplayLabel(providerId),
    };
  }

  if (!trimmedHandle.startsWith("@") && segments.length >= 2) {
    const providerId = segments[0]?.toLowerCase();
    if (!providerId) {
      return undefined;
    }

    return {
      id: providerId,
      name: DISPLAY_LABEL_OVERRIDES.get(providerId) ?? toDisplayLabel(providerId),
    };
  }

  return undefined;
}

export function isCloudflareCompatModelHandle(modelHandle: string): boolean {
  const normalizedHandle = modelHandle.trim();
  return normalizedHandle.includes("/") && !normalizedHandle.startsWith("@");
}

export function toCloudflareCompatModelHandle(modelHandle: string): string {
  const normalizedHandle = modelHandle.trim();
  if (normalizedHandle.startsWith("@")) {
    return `workers-ai/${normalizedHandle}`;
  }

  return normalizedHandle;
}

export function getCloudflareModelHandle(model: Pick<CloudflareModel, "id" | "name">): string {
  const name = model.name?.trim();
  if (name && name.startsWith("@")) {
    return name;
  }

  return model.id;
}

function toTaskId(taskName: string): string {
  return taskName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
}

function doesModelMatchFilter(model: CloudflareModel, filter: string): boolean {
  if (filter === ALL_MODEL_FILTER) {
    return true;
  }

  const taskName = model.task?.name?.trim();
  const taskId = model.task?.id?.trim();
  const normalizedTaskId = toTaskId(filter);

  return taskName === filter || taskId === normalizedTaskId;
}

function getHandleLeaf(modelHandle: string): string {
  const segments = modelHandle.split("/").filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? modelHandle;
}

function hasGatewayHint(value: string, hints: readonly string[]): boolean {
  return hints.some((hint) => value.includes(hint));
}

function inferAiGatewayTaskName(modelId: string): string {
  const normalizedModelId = modelId.trim().toLowerCase();

  if (hasGatewayHint(normalizedModelId, GATEWAY_TEXT_EMBEDDING_HINTS)) {
    return "Text Embeddings";
  }

  if (hasGatewayHint(normalizedModelId, GATEWAY_AUDIO_INPUT_HINTS)) {
    return "Automatic Speech Recognition";
  }

  if (hasGatewayHint(normalizedModelId, GATEWAY_AUDIO_OUTPUT_HINTS)) {
    return "Text-to-Speech";
  }

  if (hasGatewayHint(normalizedModelId, GATEWAY_VIDEO_HINTS)) {
    return "Text-to-Video";
  }

  if (hasGatewayHint(normalizedModelId, GATEWAY_IMAGE_HINTS)) {
    return "Text-to-Image";
  }

  if (hasGatewayHint(normalizedModelId, GATEWAY_MUSIC_HINTS)) {
    return "Music Generation";
  }

  return TEXT_GENERATION_TASK_NAME;
}

function inferCompatModelCapabilities(
  modelHandle: string,
  taskName: string,
): CloudflareDetectedCapabilities | undefined {
  if (taskName !== TEXT_GENERATION_TASK_NAME) {
    return undefined;
  }

  const normalizedHandle = modelHandle.toLowerCase();
  const capabilities: CloudflareDetectedCapabilities = {
    toolCalling: true,
    structuredOutput: true,
  };

  if (inferCompatReasoningEffortLevels(modelHandle, taskName)) {
    capabilities.reasoning = true;
  }

  if (hasGatewayHint(normalizedHandle, GATEWAY_VISION_HINTS)) {
    capabilities.imageInput = true;
  }

  return capabilities;
}

function inferCompatReasoningEffortLevels(
  modelHandle: string,
  taskName: string,
): readonly string[] | undefined {
  if (taskName !== TEXT_GENERATION_TASK_NAME) {
    return undefined;
  }

  return hasGatewayHint(modelHandle.toLowerCase(), GATEWAY_REASONING_HINTS)
    ? COMPAT_REASONING_EFFORT_LEVELS
    : undefined;
}

function toNormalizedWorkersAiModel(model: CloudflareModel): CloudflareModel {
  const modelHandle = getCloudflareModelHandle(model);

  return {
    ...model,
    source: model.source ?? "workers-ai",
    transport: model.transport ?? "direct",
    provider: model.provider ?? inferModelProviderFromHandle(modelHandle),
  };
}

function buildAiGatewayModel(
  providerId: string,
  providerLabel: string,
  modelId: string,
): CloudflareModel {
  const taskName = inferAiGatewayTaskName(modelId);
  const modelHandle = `${providerId}/${modelId}`;
  const reasoningEffortLevels = inferCompatReasoningEffortLevels(modelHandle, taskName);

  return {
    id: modelHandle,
    name: modelId,
    description: `AI Gateway supported model from ${providerLabel}`,
    source: "ai-gateway",
    transport: "compat",
    provider: {
      id: providerId,
      name: providerLabel,
    },
    task: {
      id: toTaskId(taskName),
      name: taskName,
    },
    detectedCapabilities: inferCompatModelCapabilities(modelHandle, taskName),
    reasoningEffortLevels,
  };
}

function getSupportedModelProviderId(providerUrl: string): string | undefined {
  try {
    const absoluteUrl = new URL(providerUrl, AI_GATEWAY_SUPPORTED_MODELS_URL);
    const pathSegments = absoluteUrl.pathname.split("/").filter((segment) => segment.length > 0);
    const providersIndex = pathSegments.findIndex((segment) => segment === "providers");
    const providerId = providersIndex >= 0 ? pathSegments[providersIndex + 1] : undefined;
    return providerId?.trim().toLowerCase();
  } catch {
    return undefined;
  }
}

export async function fetchCloudflareAiGatewayModels(
  filter: string = TEXT_GENERATION_MODEL_FILTER,
  includedProviders: readonly string[] = [],
  signal?: AbortSignal,
): Promise<CloudflareModel[]> {
  const normalizedFilter = getAiGatewayModelFilter(filter);
  const response = await fetch(AI_GATEWAY_SUPPORTED_MODELS_URL, {
    headers: {
      "Content-Type": "text/markdown",
    },
    signal,
  });
  const raw = await response.text();

  if (!response.ok) {
    throw new Error(
      `Cloudflare AI Gateway model catalog request failed (${response.status}): ${raw}`,
    );
  }

  const providerFilter = new Set(
    includedProviders.map((providerId) => providerId.trim().toLowerCase()).filter(Boolean),
  );
  const dedupedModels = new Map<string, CloudflareModel>();
  const tableRowPattern =
    /^\|\s*\[(?<providerLabel>[^\]]+)\]\((?<providerUrl>[^)]+)\)\s*\|\s*(?<modelId>[^|]+?)\s*\|$/gmu;

  for (const match of raw.matchAll(tableRowPattern)) {
    const providerLabel = match.groups?.providerLabel?.trim();
    const providerUrl = match.groups?.providerUrl?.trim();
    const modelId = match.groups?.modelId?.trim();

    if (!providerLabel || !providerUrl || !modelId) {
      continue;
    }

    const providerId = getSupportedModelProviderId(providerUrl);
    if (!providerId) {
      continue;
    }

    if (providerFilter.size > 0 && !providerFilter.has(providerId)) {
      continue;
    }

    const model = buildAiGatewayModel(providerId, providerLabel, modelId);
    if (!doesModelMatchFilter(model, normalizedFilter)) {
      continue;
    }

    dedupedModels.set(getCloudflareModelHandle(model), model);
  }

  return [...dedupedModels.values()];
}

function normalizeManualModelHandle(modelHandle: string): string | undefined {
  const normalizedHandle = modelHandle.trim();
  if (normalizedHandle.length === 0) {
    return undefined;
  }

  if (normalizedHandle.startsWith("workers-ai/@")) {
    return normalizedHandle.slice("workers-ai/".length);
  }

  return normalizedHandle;
}

export function parseManualCloudflareModels(entries: readonly unknown[] | undefined): {
  models: CloudflareModel[];
  warnings: string[];
} {
  const models: CloudflareModel[] = [];
  const warnings: string[] = [];

  for (const [index, entry] of (entries ?? []).entries()) {
    const entryRecord = getObjectRecord(entry);
    if (!entryRecord) {
      warnings.push(`manualModels[${index}] must be an object.`);
      continue;
    }

    const configuredModelHandle =
      typeof entryRecord.model === "string" ? entryRecord.model : undefined;
    const modelHandle = configuredModelHandle
      ? normalizeManualModelHandle(configuredModelHandle)
      : undefined;
    if (!modelHandle) {
      warnings.push(`manualModels[${index}].model must be a non-empty string.`);
      continue;
    }

    const configuredTask =
      typeof entryRecord.task === "string" && entryRecord.task.trim().length > 0
        ? entryRecord.task.trim()
        : undefined;
    const taskName = configuredTask ?? inferAiGatewayTaskName(getHandleLeaf(modelHandle));
    const inferredCapabilities = isCloudflareCompatModelHandle(modelHandle)
      ? inferCompatModelCapabilities(modelHandle, taskName)
      : undefined;
    const inferredReasoningEffortLevels = isCloudflareCompatModelHandle(modelHandle)
      ? inferCompatReasoningEffortLevels(modelHandle, taskName)
      : undefined;
    const explicitCapabilities = readManualCloudflareModelCapabilities(entryRecord.capabilities);
    const parsedReasoningEffortLevels = Array.isArray(entryRecord.reasoningEffortLevels)
      ? [
          ...new Set(
            entryRecord.reasoningEffortLevels
              .filter((level): level is string => typeof level === "string")
              .map((level) => level.trim())
              .filter((level) => level.length > 0),
          ),
        ]
      : entryRecord.reasoningEffortLevels === undefined
        ? undefined
        : [];
    const reasoningEffortLevels =
      parsedReasoningEffortLevels === undefined
        ? inferredReasoningEffortLevels
        : parsedReasoningEffortLevels;
    if (
      entryRecord.reasoningEffortLevels !== undefined &&
      (!Array.isArray(entryRecord.reasoningEffortLevels) ||
        (parsedReasoningEffortLevels !== undefined && parsedReasoningEffortLevels.length === 0))
    ) {
      warnings.push(
        `manualModels[${index}].reasoningEffortLevels must be an array of non-empty strings.`,
      );
    }
    const modelName =
      typeof entryRecord.name === "string" && entryRecord.name.trim().length > 0
        ? entryRecord.name.trim()
        : getHandleLeaf(modelHandle);
    const description =
      typeof entryRecord.description === "string" && entryRecord.description.trim().length > 0
        ? entryRecord.description.trim()
        : undefined;

    models.push({
      id: modelHandle,
      name: modelName,
      description,
      source: "manual",
      transport: isCloudflareCompatModelHandle(modelHandle) ? "compat" : "direct",
      provider: inferModelProviderFromHandle(modelHandle),
      task: {
        id: toTaskId(taskName),
        name: taskName,
      },
      detectedCapabilities: {
        ...inferredCapabilities,
        ...explicitCapabilities,
        ...(reasoningEffortLevels && reasoningEffortLevels.length > 0 ? { reasoning: true } : {}),
      },
      reasoningEffortLevels,
    });
  }

  return { models, warnings };
}

function truncateNormalizedText(value: string): string {
  return value.length > MAX_NORMALIZED_TEXT_LENGTH
    ? value.slice(0, MAX_NORMALIZED_TEXT_LENGTH)
    : value;
}

function normalizeTextValue(value: unknown): string {
  return truncateNormalizedText(normalizeSearchText(value));
}

function getCloudflareModelMetadataText(model: CloudflareModel): string {
  const propertiesText =
    model.properties
      ?.map(
        (property) =>
          `${normalizeTextValue(property.property_id)} ${normalizeTextValue(property.value)}`,
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
    .map((value) => normalizeTextValue(value))
    .join(" ");
}

function hasModelHint(model: CloudflareModel, hints: readonly string[]): boolean {
  const metadata = getCloudflareModelMetadataText(model);
  return hints.some((hint) => metadata.includes(hint));
}

function getCloudflareModelSlug(model: CloudflareModel): string {
  const handle = getCloudflareModelHandle(model);
  const segments = handle.split("/").filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? handle;
}

function getCloudflareModelAuthorSegment(model: CloudflareModel): string | undefined {
  const explicitProviderId = model.provider?.id?.trim().toLowerCase();
  if (explicitProviderId) {
    return explicitProviderId;
  }

  const handle = getCloudflareModelHandle(model);
  const segments = handle.split("/").filter((segment) => segment.length > 0);

  if (handle.startsWith("@") && segments.length >= 3) {
    return segments[1]?.toLowerCase();
  }

  if (!handle.startsWith("@") && segments.length >= 2) {
    return segments[0]?.toLowerCase();
  }

  return undefined;
}

function toDisplayLabel(value: string): string {
  const normalizedValue = value.trim().toLowerCase();
  const wholeValueOverride = DISPLAY_LABEL_OVERRIDES.get(normalizedValue);
  if (wholeValueOverride) {
    return wholeValueOverride;
  }

  return value
    .split(/[-_]/u)
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      const normalizedSegment = segment.toLowerCase();
      return (
        DISPLAY_LABEL_OVERRIDES.get(normalizedSegment) ??
        segment.charAt(0).toUpperCase() + segment.slice(1)
      );
    })
    .join(" ");
}

function isVersionToken(token: string): boolean {
  return /^(?:v|r)?\d+(?:\.\d+)*[a-z]*$/u.test(token) || /^(?:[a-z]+)\d+(?:\.\d+)*$/u.test(token);
}

function isModelSizeToken(token: string): boolean {
  return /^\d+(?:\.\d+)?b$/u.test(token);
}

function cleanFamilyToken(token: string): string {
  return token
    .toLowerCase()
    .replace(/([a-z]+)\d+(?:\.\d+)*$/u, "$1")
    .replace(/\d+(?:\.\d+)*$/u, "")
    .replace(/[^a-z]+$/u, "");
}

function inferCloudflareModelFamilySlug(model: CloudflareModel): string {
  const tokens = getCloudflareModelSlug(model)
    .split(/[-_]/u)
    .filter((token) => token.length > 0);
  const familyTokens: string[] = [];

  for (const token of tokens) {
    const lowerToken = token.toLowerCase();
    if (isModelSizeToken(lowerToken) || FAMILY_SUFFIX_HINTS.has(lowerToken)) {
      if (familyTokens.length > 0) {
        break;
      }

      continue;
    }

    if (isVersionToken(lowerToken) && familyTokens.length > 0) {
      break;
    }

    const cleanedToken = cleanFamilyToken(lowerToken);
    if (cleanedToken.length === 0) {
      continue;
    }

    familyTokens.push(cleanedToken);
    if (familyTokens.length >= 2) {
      break;
    }
  }

  if (familyTokens.length > 0) {
    return familyTokens.join("-");
  }

  const fallbackToken = cleanFamilyToken(tokens[0] ?? getCloudflareModelSlug(model));
  return fallbackToken.length > 0 ? fallbackToken : getCloudflareModelSlug(model).toLowerCase();
}

function findVersionCandidate(value: string): string | undefined {
  const normalized = value.toLowerCase();
  const matchers: Array<{ regex: RegExp; group?: number }> = [
    { regex: /\b(r\d+(?:\.\d+)*)\b/u },
    { regex: /\bv(\d+(?:\.\d+)*)\b/u, group: 1 },
    { regex: /\b(\d+(?:\.\d+)+)\b/u, group: 1 },
    {
      regex:
        /(?:^|[-_])(\d+(?:-\d+)+)(?=[-_](?:flash|haiku|large|lite|mini|nano|opus|pro|small|sonnet|turbo|ultra)|$)/u,
      group: 1,
    },
    { regex: /[a-z]+(\d+(?:\.\d+)+)\b/u, group: 1 },
    {
      regex:
        /(?:^|[-_])(\d+)(?=[-_](?:chat|coder|distill|fast|flash|haiku|instruct|large|lite|maverick|mini|nano|opus|preview|pro|reasoning|scout|small|sonnet|turbo|vision)|$)/u,
      group: 1,
    },
  ];

  for (const matcher of matchers) {
    const match = matcher.regex.exec(normalized);
    const candidate = matcher.group ? match?.[matcher.group] : match?.[0];
    if (candidate && candidate.length > 0) {
      return candidate.includes("-") ? candidate.replace(/-/gu, ".") : candidate;
    }
  }

  return undefined;
}

function getCloudflareModelVersionFromProperties(model: CloudflareModel): string | undefined {
  for (const property of model.properties ?? []) {
    const propertyId = normalizeTextValue(property.property_id);
    if (!propertyId.includes("version") && !propertyId.includes("release")) {
      continue;
    }

    const parsed = findVersionCandidate(normalizeTextValue(property.value));
    if (parsed) {
      return parsed;
    }
  }

  return undefined;
}

function getCloudflareModelSizeInBillions(model: CloudflareModel): number | undefined {
  const metadata = getCloudflareModelMetadataText(model);
  const candidates = Array.from(metadata.matchAll(/(\d+(?:\.\d+)?)b\b/gu))
    .map((match) => Number(match[1]))
    .filter((candidate) => Number.isFinite(candidate));

  return candidates.length > 0 ? Math.min(...candidates) : undefined;
}

function isExperimentalModel(model: CloudflareModel): boolean {
  return hasModelHint(model, EXPERIMENTAL_MODEL_HINTS);
}

function getCloudflareModelRankingScore(model: CloudflareModel): number {
  let score = 0;

  if (model.task?.name === TEXT_GENERATION_TASK_NAME) {
    score += 1_000;
  }

  if (model.detectedCapabilities?.toolCalling) {
    score += 120;
  }

  if (model.detectedCapabilities?.structuredOutput) {
    score += 60;
  }

  if (model.detectedCapabilities?.reasoning) {
    score += 40;
  }

  if (model.detectedCapabilities?.imageInput) {
    score += 20;
  }

  if (isExperimentalModel(model)) {
    score -= 200;
  }

  return score;
}

function getCompletionModelRankingScore(model: CloudflareModel): number {
  if (model.task?.name !== TEXT_GENERATION_TASK_NAME) {
    return Number.NEGATIVE_INFINITY;
  }

  let score = getCloudflareModelRankingScore(model);
  const metadata = getCloudflareModelMetadataText(model);
  const sizeInBillions = getCloudflareModelSizeInBillions(model);

  if (COMPLETION_MODEL_HINTS.some((hint) => metadata.includes(hint))) {
    score += 220;
  }

  if (COMPLETION_CHAT_HINTS.some((hint) => metadata.includes(hint))) {
    score += 40;
  }

  if (COMPLETION_FAST_HINTS.some((hint) => metadata.includes(hint))) {
    score += 35;
  }

  if (COMPLETION_SLOW_HINTS.some((hint) => metadata.includes(hint))) {
    score -= 25;
  }

  if (model.detectedCapabilities?.imageInput) {
    score -= 30;
  }

  if (model.detectedCapabilities?.reasoning) {
    score -= 10;
  }

  if (sizeInBillions !== undefined) {
    if (sizeInBillions <= 8) {
      score += 25;
    } else if (sizeInBillions <= 20) {
      score += 10;
    } else if (sizeInBillions >= 70) {
      score -= 20;
    }
  }

  return score;
}

function normalizeModelLookupValue(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

export function getCloudflareModelFamily(model: CloudflareModel): string {
  const authorSegment = getCloudflareModelAuthorSegment(model);
  const familySlug = inferCloudflareModelFamilySlug(model);

  return authorSegment ? `${authorSegment}/${familySlug}` : familySlug;
}

export function getCloudflareModelVersion(model: CloudflareModel): string {
  return (
    getCloudflareModelVersionFromProperties(model) ??
    findVersionCandidate(getCloudflareModelHandle(model)) ??
    findVersionCandidate(normalizeTextValue(model.name)) ??
    findVersionCandidate(normalizeTextValue(model.description)) ??
    "unknown"
  );
}

export function getCloudflareModelPickerCategory(
  model: CloudflareModel,
): CloudflareModelPickerCategory {
  const authorSegment = getCloudflareModelAuthorSegment(model);
  const authorLabel =
    model.provider?.name?.trim() || (authorSegment ? toDisplayLabel(authorSegment) : "Cloudflare");
  const taskName = model.task?.name?.trim();

  if (taskName && taskName !== TEXT_GENERATION_TASK_NAME) {
    return {
      label: `${authorLabel} • ${taskName}`,
      order: 20,
    };
  }

  return {
    label: authorLabel,
    order: 10,
  };
}

export function sortCloudflareModels(models: readonly CloudflareModel[]): CloudflareModel[] {
  return [...models].sort((left, right) => {
    const scoreDifference =
      getCloudflareModelRankingScore(right) - getCloudflareModelRankingScore(left);
    if (scoreDifference !== 0) {
      return scoreDifference;
    }

    const categoryDifference = getCloudflareModelPickerCategory(left).label.localeCompare(
      getCloudflareModelPickerCategory(right).label,
    );
    if (categoryDifference !== 0) {
      return categoryDifference;
    }

    const familyDifference = getCloudflareModelFamily(left).localeCompare(
      getCloudflareModelFamily(right),
    );
    if (familyDifference !== 0) {
      return familyDifference;
    }

    const versionDifference = getCloudflareModelVersion(right).localeCompare(
      getCloudflareModelVersion(left),
    );
    if (versionDifference !== 0) {
      return versionDifference;
    }

    return getCloudflareModelHandle(left).localeCompare(getCloudflareModelHandle(right));
  });
}

export function selectCloudflareCompletionModel(
  models: readonly CloudflareModel[],
  preferredModelHandle?: string,
): CloudflareModel | undefined {
  const textGenerationModels = models.filter(
    (model) => model.task?.name === TEXT_GENERATION_TASK_NAME,
  );
  if (textGenerationModels.length === 0) {
    return undefined;
  }

  const normalizedPreferredModel = normalizeModelLookupValue(preferredModelHandle);
  if (normalizedPreferredModel) {
    const preferredMatch = textGenerationModels.find((model) =>
      [getCloudflareModelHandle(model), model.id, model.name]
        .map((candidate) => normalizeModelLookupValue(candidate))
        .some((candidate) => candidate === normalizedPreferredModel),
    );

    if (preferredMatch) {
      return preferredMatch;
    }
  }

  return [...textGenerationModels].sort((left, right) => {
    const scoreDifference =
      getCompletionModelRankingScore(right) - getCompletionModelRankingScore(left);
    if (scoreDifference !== 0) {
      return scoreDifference;
    }

    return getCloudflareModelHandle(left).localeCompare(getCloudflareModelHandle(right));
  })[0];
}

async function fetchCloudflareModelSchema(
  accountId: string,
  apiKey: string,
  modelId: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const url = new URL(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/models/schema`,
  );
  url.searchParams.set("model", modelId);

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    signal,
  });
  const raw = await response.text();

  if (!response.ok) {
    throw new Error(`Cloudflare schema request failed (${response.status}): ${raw}`);
  }

  return parseJson(raw, "Failed to parse Cloudflare model schema");
}

async function detectModelCapabilities(
  accountId: string,
  apiKey: string,
  modelHandle: string,
  capabilityCache: Map<
    string,
    | {
        detectedCapabilities: CloudflareDetectedCapabilities;
        reasoningEffortLevels?: readonly string[];
      }
    | undefined
  >,
  signal?: AbortSignal,
): Promise<
  | {
      detectedCapabilities: CloudflareDetectedCapabilities;
      reasoningEffortLevels?: readonly string[];
    }
  | undefined
> {
  if (capabilityCache.has(modelHandle)) {
    return capabilityCache.get(modelHandle);
  }

  try {
    const schema = await fetchCloudflareModelSchema(accountId, apiKey, modelHandle, signal);
    const result = {
      detectedCapabilities: detectCloudflareCapabilitiesFromSchema(schema),
      reasoningEffortLevels: detectCloudflareReasoningEffortLevelsFromSchema(schema),
    };
    capabilityCache.set(modelHandle, result);
    return result;
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    capabilityCache.set(modelHandle, undefined);
    return undefined;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }

  throw signal.reason ?? new DOMException("The user aborted a request.", "AbortError");
}

export async function enrichCloudflareModelsWithCapabilities(
  accountId: string,
  apiKey: string,
  models: CloudflareModel[],
  overrides: Record<string, Partial<CloudflareDetectedCapabilities>> = {},
  signal?: AbortSignal,
): Promise<CloudflareModel[]> {
  const capabilityCache = new Map<
    string,
    | {
        detectedCapabilities: CloudflareDetectedCapabilities;
        reasoningEffortLevels?: readonly string[];
      }
    | undefined
  >();
  const enrichedModels = models.map((model) => {
    const handle = getCloudflareModelHandle(model);
    const modelOverrides = overrides[handle] || {};
    return {
      ...model,
      detectedCapabilities: { ...model.detectedCapabilities, ...modelOverrides },
    };
  });

  const candidateIndexes = enrichedModels
    .map((model, index) => ({ model, index }))
    .filter(
      ({ model }) =>
        model.task?.name === TEXT_GENERATION_TASK_NAME &&
        !isCloudflareCompatModelHandle(getCloudflareModelHandle(model)),
    );

  for (let index = 0; index < candidateIndexes.length; index += SCHEMA_BATCH_SIZE) {
    throwIfAborted(signal);
    const batch = candidateIndexes.slice(index, index + SCHEMA_BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async ({ model, index: modelIndex }) => ({
        modelIndex,
        detectedCapabilities: await detectModelCapabilities(
          accountId,
          apiKey,
          getCloudflareModelHandle(model),
          capabilityCache,
          signal,
        ),
      })),
    );

    throwIfAborted(signal);

    for (const result of results) {
      if (result.detectedCapabilities === undefined) {
        continue;
      }

      const handle = getCloudflareModelHandle(enrichedModels[result.modelIndex]);
      const currentOverrides = overrides[handle] || {};
      enrichedModels[result.modelIndex].detectedCapabilities = {
        ...enrichedModels[result.modelIndex].detectedCapabilities,
        ...result.detectedCapabilities.detectedCapabilities,
        ...currentOverrides,
      };
      if (result.detectedCapabilities.reasoningEffortLevels?.length) {
        enrichedModels[result.modelIndex].reasoningEffortLevels =
          result.detectedCapabilities.reasoningEffortLevels;
      }
    }
  }

  return enrichedModels;
}

export async function fetchCloudflareModels(
  accountId: string,
  apiKey: string,
  filter: string = TEXT_GENERATION_MODEL_FILTER,
  signal?: AbortSignal,
): Promise<CloudflareModel[]> {
  const normalizedFilter = normalizeCloudflareModelFilter(filter);
  const dedupedModels = new Map<string, CloudflareModel>();

  for (let page = 1; page <= MAX_MODEL_SEARCH_PAGES; page += 1) {
    throwIfAborted(signal);
    const url = new URL(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/models/search`,
    );
    url.searchParams.set("per_page", MODEL_SEARCH_PAGE_SIZE.toString());
    url.searchParams.set("page", page.toString());

    if (normalizedFilter !== ALL_MODEL_FILTER) {
      url.searchParams.set("task", normalizedFilter);
    }

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal,
    });
    const raw = await response.text();

    if (!response.ok) {
      throw new Error(`Cloudflare API request failed (${response.status}): ${raw}`);
    }

    const json = parseJson(
      raw,
      "Failed to parse Cloudflare models response",
    ) as CloudflareModelsResponse;

    if (!json.success) {
      const errMsg = json.errors?.map((e) => e.message).join(", ") ?? "Unknown error";
      throw new Error(`Cloudflare API error: ${errMsg}`);
    }

    for (const rawModel of json.result) {
      const model = toNormalizedWorkersAiModel(rawModel);
      const dedupeKey = getCloudflareModelHandle(model);
      if (!dedupedModels.has(dedupeKey)) {
        dedupedModels.set(dedupeKey, model);
      }
    }

    const totalPages = json.result_info?.total_pages;
    if (typeof totalPages === "number") {
      if (page >= totalPages) {
        break;
      }
      continue;
    }

    if (json.result.length < MODEL_SEARCH_PAGE_SIZE) {
      break;
    }
  }

  return [...dedupedModels.values()];
}
