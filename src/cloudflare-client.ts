export interface CloudflareModel {
  id: string; // Cloudflare internal model UUID
  name?: string;
  description?: string;
  task?: {
    id: string;
    name?: string; // e.g. "Text Generation"
    description?: string;
  };
  properties?: Array<{ property_id: string; value: unknown }>;
  detectedCapabilities?: {
    toolCalling?: boolean;
    imageInput?: boolean;
    structuredOutput?: boolean;
    reasoning?: boolean;
    audioInput?: boolean;
    audioOutput?: boolean;
  };
}

export interface CloudflareModelPickerCategory {
  label: string;
  order: number;
}

type DetectedCloudflareModelCapabilities = NonNullable<CloudflareModel["detectedCapabilities"]>;

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

const ALL_MODELS_FILTER = "all";
const TEXT_GENERATION_TASK = "Text Generation";
const SCHEMA_BATCH_SIZE = 5;
const MODEL_SEARCH_PAGE_SIZE = 100;
const MAX_MODEL_SEARCH_PAGES = 20;
const MAX_NORMALIZED_TEXT_LENGTH = 4096;
const TOOL_CALLING_INPUT_PROPERTIES = new Set([
  "tools",
  "tool_choice",
  "functions",
  "function_call",
  "parallel_tool_calls",
]);
const TOOL_CALLING_OUTPUT_PROPERTIES = new Set(["tool_calls"]);
const REASONING_INPUT_PROPERTIES = new Set([
  "reasoning_effort",
  "chat_template_kwargs",
  "enable_thinking",
  "clear_thinking",
]);
const AUDIO_OUTPUT_INPUT_PROPERTIES = new Set(["audio", "modalities"]);
const AUDIO_OUTPUT_OUTPUT_PROPERTIES = new Set(["audio"]);
const STRUCTURED_OUTPUT_ENUM_VALUES = new Set(["json_object", "json_schema"]);
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

export function getCloudflareModelHandle(model: Pick<CloudflareModel, "id" | "name">): string {
  const name = model.name?.trim();
  if (name && name.startsWith("@")) {
    return name;
  }

  return model.id;
}

function truncateNormalizedText(value: string): string {
  return value.length > MAX_NORMALIZED_TEXT_LENGTH
    ? value.slice(0, MAX_NORMALIZED_TEXT_LENGTH)
    : value;
}

function normalizeTextValue(value: unknown): string {
  if (typeof value === "string") {
    return truncateNormalizedText(value.toLowerCase());
  }

  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return truncateNormalizedText(value.toString().toLowerCase());
  }

  try {
    return truncateNormalizedText(JSON.stringify(value)?.toLowerCase() ?? "");
  } catch {
    return "";
  }
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
  const handle = getCloudflareModelHandle(model);
  const segments = handle.split("/").filter((segment) => segment.length > 0);

  if (handle.startsWith("@") && segments.length >= 3) {
    return segments[1]?.toLowerCase();
  }

  return undefined;
}

function toDisplayLabel(value: string): string {
  return value
    .split(/[-_]/u)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
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
    { regex: /[a-z]+(\d+(?:\.\d+)+)\b/u, group: 1 },
    {
      regex:
        /(?:^|[-_])(\d+)(?=[-_](?:chat|coder|distill|fast|instruct|maverick|preview|reasoning|scout|turbo|vision)|$)/u,
      group: 1,
    },
  ];

  for (const matcher of matchers) {
    const match = matcher.regex.exec(normalized);
    const candidate = matcher.group ? match?.[matcher.group] : match?.[0];
    if (candidate && candidate.length > 0) {
      return candidate;
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

  if (model.task?.name === TEXT_GENERATION_TASK) {
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
  if (model.task?.name !== TEXT_GENERATION_TASK) {
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
  const authorLabel = authorSegment ? toDisplayLabel(authorSegment) : "Cloudflare";
  const taskName = model.task?.name?.trim();

  if (taskName && taskName !== TEXT_GENERATION_TASK) {
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
  const textGenerationModels = models.filter((model) => model.task?.name === TEXT_GENERATION_TASK);
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getObjectRecord(value: unknown): Record<string, unknown> | undefined {
  if (!isObject(value)) {
    return undefined;
  }

  return value;
}

function getSchemaVariants(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => getSchemaVariants(item));
  }

  const record = getObjectRecord(value);
  if (!record) {
    return [value];
  }

  const anyOf = Array.isArray(record.anyOf) ? record.anyOf : [];
  const oneOf = Array.isArray(record.oneOf) ? record.oneOf : [];

  if (anyOf.length === 0 && oneOf.length === 0) {
    return [record];
  }

  const nestedVariants = [...anyOf, ...oneOf].flatMap((item) => getSchemaVariants(item));
  return nestedVariants.length > 0 ? nestedVariants : [record];
}

function getSchemaProperties(value: unknown): Record<string, unknown>[] {
  return getSchemaVariants(value)
    .map((variant) => getObjectRecord(variant))
    .flatMap((variant) => {
      if (!variant) {
        return [];
      }

      const properties = getObjectRecord(variant.properties);
      return properties ? [properties] : [];
    });
}

function findPropertySchemas(value: unknown, propertyNames: ReadonlySet<string>): unknown[] {
  return getSchemaProperties(value).flatMap((properties) =>
    Object.entries(properties)
      .filter(([propertyName]) => propertyNames.has(propertyName))
      .map(([, propertySchema]) => propertySchema),
  );
}

function schemaContainsPropertyName(value: unknown, propertyNames: ReadonlySet<string>): boolean {
  const variants = getSchemaVariants(value);

  return variants.some((variant) => {
    const record = getObjectRecord(variant);
    if (!record) {
      return false;
    }

    const properties = getObjectRecord(record.properties);
    if (
      properties &&
      Object.keys(properties).some((propertyName) => propertyNames.has(propertyName))
    ) {
      return true;
    }

    return Object.values(record).some((child) => schemaContainsPropertyName(child, propertyNames));
  });
}

function schemaContainsEnumValue(value: unknown, enumValues: ReadonlySet<string>): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => schemaContainsEnumValue(item, enumValues));
  }

  const record = getObjectRecord(value);
  if (!record) {
    return false;
  }

  const enumCandidates = Array.isArray(record.enum)
    ? record.enum.filter((candidate): candidate is string => typeof candidate === "string")
    : [];

  if (enumCandidates.some((candidate) => enumValues.has(candidate))) {
    return true;
  }

  return Object.values(record).some((child) => schemaContainsEnumValue(child, enumValues));
}

function getSchemaSection(schemaResult: unknown, sectionName: "input" | "output"): unknown {
  const record = getObjectRecord(schemaResult);
  if (!record || !(sectionName in record)) {
    return undefined;
  }

  return record[sectionName];
}

function getMessageContentSchemas(inputSchema: unknown): unknown[] {
  const messageSchemas = findPropertySchemas(inputSchema, new Set(["messages"]));
  return messageSchemas.flatMap((messageSchema) =>
    findPropertySchemas(messageSchema, new Set(["content"])),
  );
}

function messageContentSupportsType(inputSchema: unknown, messageType: string): boolean {
  return getMessageContentSchemas(inputSchema).some((contentSchema) =>
    schemaContainsEnumValue(contentSchema, new Set([messageType])),
  );
}

function responseFormatSupportsStructuredOutput(inputSchema: unknown): boolean {
  const responseFormatSchemas = findPropertySchemas(inputSchema, new Set(["response_format"]));
  return responseFormatSchemas.some((schema) =>
    schemaContainsEnumValue(schema, STRUCTURED_OUTPUT_ENUM_VALUES),
  );
}

function modalitiesSupportAudioOutput(inputSchema: unknown): boolean {
  const modalitiesSchemas = findPropertySchemas(inputSchema, new Set(["modalities"]));
  return modalitiesSchemas.some((schema) => schemaContainsEnumValue(schema, new Set(["audio"])));
}

function getSchemaResult(schema: unknown): unknown {
  if (!isObject(schema) || !("result" in schema)) {
    return schema;
  }

  return schema.result;
}

async function fetchCloudflareModelSchema(
  accountId: string,
  apiKey: string,
  modelId: string,
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
  });
  const raw = await response.text();

  if (!response.ok) {
    throw new Error(`Cloudflare schema request failed (${response.status}): ${raw}`);
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    throw new Error(`Failed to parse Cloudflare model schema (${message}): ${raw}`);
  }
}

function detectToolCallingSupport(inputSchema: unknown, outputSchema: unknown): boolean {
  return (
    schemaContainsPropertyName(inputSchema, TOOL_CALLING_INPUT_PROPERTIES) ||
    schemaContainsPropertyName(outputSchema, TOOL_CALLING_OUTPUT_PROPERTIES)
  );
}

function detectImageInputSupport(inputSchema: unknown): boolean {
  return messageContentSupportsType(inputSchema, "image_url");
}

function detectStructuredOutputSupport(inputSchema: unknown): boolean {
  return responseFormatSupportsStructuredOutput(inputSchema);
}

function detectReasoningSupport(inputSchema: unknown): boolean {
  return schemaContainsPropertyName(inputSchema, REASONING_INPUT_PROPERTIES);
}

function detectAudioInputSupport(inputSchema: unknown): boolean {
  return messageContentSupportsType(inputSchema, "input_audio");
}

function detectAudioOutputSupport(inputSchema: unknown, outputSchema: unknown): boolean {
  return (
    (schemaContainsPropertyName(inputSchema, AUDIO_OUTPUT_INPUT_PROPERTIES) &&
      modalitiesSupportAudioOutput(inputSchema)) ||
    schemaContainsPropertyName(outputSchema, AUDIO_OUTPUT_OUTPUT_PROPERTIES)
  );
}

async function detectModelCapabilities(
  accountId: string,
  apiKey: string,
  modelHandle: string,
  capabilityCache: Map<string, DetectedCloudflareModelCapabilities | undefined>,
): Promise<DetectedCloudflareModelCapabilities | undefined> {
  if (capabilityCache.has(modelHandle)) {
    return capabilityCache.get(modelHandle);
  }

  try {
    const schema = await fetchCloudflareModelSchema(accountId, apiKey, modelHandle);
    const schemaResult = getSchemaResult(schema);
    const inputSchema = getSchemaSection(schemaResult, "input");
    const outputSchema = getSchemaSection(schemaResult, "output");
    const detectedCapabilities = {
      toolCalling: detectToolCallingSupport(inputSchema, outputSchema),
      imageInput: detectImageInputSupport(inputSchema),
      structuredOutput: detectStructuredOutputSupport(inputSchema),
      reasoning: detectReasoningSupport(inputSchema),
      audioInput: detectAudioInputSupport(inputSchema),
      audioOutput: detectAudioOutputSupport(inputSchema, outputSchema),
    };
    capabilityCache.set(modelHandle, detectedCapabilities);
    return detectedCapabilities;
  } catch {
    capabilityCache.set(modelHandle, undefined);
    return undefined;
  }
}

export async function enrichCloudflareModelsWithCapabilities(
  accountId: string,
  apiKey: string,
  models: CloudflareModel[],
  overrides: Record<string, Partial<DetectedCloudflareModelCapabilities>> = {},
): Promise<CloudflareModel[]> {
  const capabilityCache = new Map<string, DetectedCloudflareModelCapabilities | undefined>();
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
    .filter(({ model }) => model.task?.name === TEXT_GENERATION_TASK);

  for (let index = 0; index < candidateIndexes.length; index += SCHEMA_BATCH_SIZE) {
    const batch = candidateIndexes.slice(index, index + SCHEMA_BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async ({ model, index: modelIndex }) => ({
        modelIndex,
        detectedCapabilities: await detectModelCapabilities(
          accountId,
          apiKey,
          getCloudflareModelHandle(model),
          capabilityCache,
        ),
      })),
    );

    for (const result of results) {
      if (result.detectedCapabilities === undefined) {
        continue;
      }

      const handle = getCloudflareModelHandle(enrichedModels[result.modelIndex]);
      const currentOverrides = overrides[handle] || {};
      enrichedModels[result.modelIndex].detectedCapabilities = {
        ...enrichedModels[result.modelIndex].detectedCapabilities,
        ...result.detectedCapabilities,
        ...currentOverrides,
      };
    }
  }

  return enrichedModels;
}

export async function fetchCloudflareModels(
  accountId: string,
  apiKey: string,
  filter: string = "Text Generation",
): Promise<CloudflareModel[]> {
  const dedupedModels = new Map<string, CloudflareModel>();

  for (let page = 1; page <= MAX_MODEL_SEARCH_PAGES; page += 1) {
    const url = new URL(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/models/search`,
    );
    url.searchParams.set("per_page", MODEL_SEARCH_PAGE_SIZE.toString());
    url.searchParams.set("page", page.toString());

    if (filter !== ALL_MODELS_FILTER) {
      url.searchParams.set("task", filter);
    }

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    });
    const raw = await response.text();

    if (!response.ok) {
      throw new Error(`Cloudflare API request failed (${response.status}): ${raw}`);
    }

    let json: CloudflareModelsResponse;
    try {
      json = JSON.parse(raw) as CloudflareModelsResponse;
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      throw new Error(`Failed to parse Cloudflare models response (${message}): ${raw}`);
    }

    if (!json.success) {
      const errMsg = json.errors?.map((e) => e.message).join(", ") ?? "Unknown error";
      throw new Error(`Cloudflare API error: ${errMsg}`);
    }

    for (const model of json.result) {
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
