import { getObjectRecord } from "./value-utils";

export interface CloudflareDetectedCapabilities {
  toolCalling?: boolean;
  imageInput?: boolean;
  structuredOutput?: boolean;
  reasoning?: boolean;
  audioInput?: boolean;
  audioOutput?: boolean;
}

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
  return getSchemaVariants(value).some((variant) => {
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

function getMessageContentSchemas(inputSchema: unknown): unknown[] {
  return findPropertySchemas(inputSchema, new Set(["messages"])).flatMap((messageSchema) =>
    findPropertySchemas(messageSchema, new Set(["content"])),
  );
}

function messageContentSupportsType(inputSchema: unknown, messageType: string): boolean {
  return getMessageContentSchemas(inputSchema).some((contentSchema) =>
    schemaContainsEnumValue(contentSchema, new Set([messageType])),
  );
}

function responseFormatSupportsStructuredOutput(inputSchema: unknown): boolean {
  return findPropertySchemas(inputSchema, new Set(["response_format"])).some((schema) =>
    schemaContainsEnumValue(schema, STRUCTURED_OUTPUT_ENUM_VALUES),
  );
}

function modalitiesSupportAudioOutput(inputSchema: unknown): boolean {
  return findPropertySchemas(inputSchema, new Set(["modalities"])).some((schema) =>
    schemaContainsEnumValue(schema, new Set(["audio"])),
  );
}

export function getCloudflareSchemaResult(schema: unknown): unknown {
  const record = getObjectRecord(schema);
  if (!record || !("result" in record)) {
    return schema;
  }

  return record.result;
}

export function getCloudflareSchemaSection(
  schemaResult: unknown,
  sectionName: "input" | "output",
): unknown {
  const record = getObjectRecord(schemaResult);
  return record?.[sectionName];
}

const SCHEMA_CAPABILITY_DETECTORS: ReadonlyArray<{
  key: keyof CloudflareDetectedCapabilities;
  detect(inputSchema: unknown, outputSchema: unknown): boolean;
}> = [
  {
    key: "toolCalling",
    detect: (inputSchema, outputSchema) =>
      schemaContainsPropertyName(inputSchema, TOOL_CALLING_INPUT_PROPERTIES) ||
      schemaContainsPropertyName(outputSchema, TOOL_CALLING_OUTPUT_PROPERTIES),
  },
  {
    key: "imageInput",
    detect: (inputSchema) => messageContentSupportsType(inputSchema, "image_url"),
  },
  {
    key: "structuredOutput",
    detect: (inputSchema) => responseFormatSupportsStructuredOutput(inputSchema),
  },
  {
    key: "reasoning",
    detect: (inputSchema) => schemaContainsPropertyName(inputSchema, REASONING_INPUT_PROPERTIES),
  },
  {
    key: "audioInput",
    detect: (inputSchema) => messageContentSupportsType(inputSchema, "input_audio"),
  },
  {
    key: "audioOutput",
    detect: (inputSchema, outputSchema) =>
      (schemaContainsPropertyName(inputSchema, AUDIO_OUTPUT_INPUT_PROPERTIES) &&
        modalitiesSupportAudioOutput(inputSchema)) ||
      schemaContainsPropertyName(outputSchema, AUDIO_OUTPUT_OUTPUT_PROPERTIES),
  },
];

export function detectCloudflareCapabilitiesFromSchema(
  schema: unknown,
): CloudflareDetectedCapabilities {
  const schemaResult = getCloudflareSchemaResult(schema);
  const inputSchema = getCloudflareSchemaSection(schemaResult, "input");
  const outputSchema = getCloudflareSchemaSection(schemaResult, "output");

  return Object.fromEntries(
    SCHEMA_CAPABILITY_DETECTORS.map((detector) => [
      detector.key,
      detector.detect(inputSchema, outputSchema),
    ]),
  ) as CloudflareDetectedCapabilities;
}

export function readManualCloudflareModelCapabilities(
  value: unknown,
): Partial<CloudflareDetectedCapabilities> | undefined {
  const record = getObjectRecord(value);
  if (!record) {
    return undefined;
  }

  const capabilities = Object.fromEntries(
    Object.entries(record).filter(([, capabilityValue]) => typeof capabilityValue === "boolean"),
  ) as Partial<CloudflareDetectedCapabilities>;

  return Object.keys(capabilities).length > 0 ? capabilities : undefined;
}
