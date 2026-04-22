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

interface CloudflareModelsResponse {
  success: boolean;
  result: CloudflareModel[];
  errors: Array<{ message: string }>;
}

const ALL_MODELS_FILTER = "all";
const TEXT_GENERATION_TASK = "Text Generation";
const SCHEMA_BATCH_SIZE = 5;
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
const detectedCapabilitiesCache = new Map<
  string,
  {
    toolCalling?: boolean;
    imageInput?: boolean;
    structuredOutput?: boolean;
    reasoning?: boolean;
    audioInput?: boolean;
    audioOutput?: boolean;
  }
>();

export function getCloudflareModelHandle(model: Pick<CloudflareModel, "id" | "name">): string {
  const name = model.name?.trim();
  if (name && name.startsWith("@")) {
    return name;
  }

  return model.id;
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
): Promise<
  | {
      toolCalling?: boolean;
      imageInput?: boolean;
      structuredOutput?: boolean;
      reasoning?: boolean;
      audioInput?: boolean;
      audioOutput?: boolean;
    }
  | undefined
> {
  const cached = detectedCapabilitiesCache.get(modelHandle);
  if (cached !== undefined) {
    return cached;
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
    detectedCapabilitiesCache.set(modelHandle, detectedCapabilities);
    return detectedCapabilities;
  } catch {
    return undefined;
  }
}

export async function enrichCloudflareModelsWithCapabilities(
  accountId: string,
  apiKey: string,
  models: CloudflareModel[],
): Promise<CloudflareModel[]> {
  const enrichedModels = models.map((model) => ({
    ...model,
    detectedCapabilities: { ...model.detectedCapabilities },
  }));

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
        ),
      })),
    );

    for (const result of results) {
      if (result.detectedCapabilities === undefined) {
        continue;
      }

      enrichedModels[result.modelIndex].detectedCapabilities = {
        ...enrichedModels[result.modelIndex].detectedCapabilities,
        ...result.detectedCapabilities,
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
  const url = new URL(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/models/search`,
  );
  url.searchParams.set("per_page", "100");

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

  return json.result;
}
