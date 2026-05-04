export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function getObjectRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function stableSerialize(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }

  if (typeof value === "bigint") {
    return JSON.stringify(value.toString());
  }

  if (typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }

  const entries = Object.entries(value).filter(([, entryValue]) => entryValue !== undefined);
  entries.sort(([left], [right]) => left.localeCompare(right));

  return `{${entries
    .map(([entryKey, entryValue]) => `${JSON.stringify(entryKey)}:${stableSerialize(entryValue)}`)
    .join(",")}}`;
}

export function computeStringFingerprint(value: string): string {
  let hash = 0x811c9dc5;

  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash.toString(16).padStart(8, "0");
}

export function normalizeSearchText(value: unknown, maxLength?: number): string {
  let normalized = "";

  if (typeof value === "string") {
    normalized = value.toLowerCase();
  } else if (value === null || value === undefined) {
    normalized = "";
  } else if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    normalized = value.toString().toLowerCase();
  } else {
    try {
      normalized = JSON.stringify(value)?.toLowerCase() ?? "";
    } catch {
      normalized = "";
    }
  }

  return typeof maxLength === "number" && normalized.length > maxLength
    ? normalized.slice(0, maxLength)
    : normalized;
}

export function formatUnknownErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") {
    return error.toString();
  }

  if (typeof error === "symbol") {
    return error.description ?? "unknown error";
  }

  try {
    const serialized = JSON.stringify(error);
    return serialized && serialized.length > 0 ? serialized : "unknown error";
  } catch {
    return "unknown error";
  }
}

export function parseJson(raw: string, errorLabel: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`${errorLabel} (${formatUnknownErrorMessage(error)}): ${raw}`);
  }
}
