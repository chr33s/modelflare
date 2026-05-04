export const ALL_MODEL_FILTER = "all";
export const LATEST_MODEL_FILTER = "latest";
export const LATEST_STABLE_MODEL_FILTER = "latest-stable";
export const TEXT_GENERATION_MODEL_FILTER = "text-generation";
export const TEXT_GENERATION_TASK_NAME = "Text Generation";

function normalizeFilterKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/gu, "-");
}

export function normalizeCloudflareModelFilter(filter: string | undefined): string {
  const trimmedFilter = filter?.trim();

  if (!trimmedFilter) {
    return TEXT_GENERATION_MODEL_FILTER;
  }

  const normalizedFilter = normalizeFilterKey(trimmedFilter);

  switch (normalizedFilter) {
    case ALL_MODEL_FILTER:
      return ALL_MODEL_FILTER;
    case LATEST_MODEL_FILTER:
      return LATEST_MODEL_FILTER;
    case LATEST_STABLE_MODEL_FILTER:
      return LATEST_STABLE_MODEL_FILTER;
    case TEXT_GENERATION_MODEL_FILTER:
      return TEXT_GENERATION_MODEL_FILTER;
    default:
      return normalizedFilter;
  }
}

export function getAiGatewayModelFilter(filter: string): string {
  const normalizedFilter = normalizeCloudflareModelFilter(filter);

  if (normalizedFilter === LATEST_MODEL_FILTER || normalizedFilter === LATEST_STABLE_MODEL_FILTER) {
    return TEXT_GENERATION_MODEL_FILTER;
  }

  return normalizedFilter;
}
