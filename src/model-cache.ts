import * as vscode from "vscode";
import type { CloudflareModel } from "./cloudflare-client";
import { logCloudflareError } from "./logging";
import { computeStringFingerprint, stableSerialize } from "./value-utils";

const MODEL_CACHE_STATE_KEY = "modelflare.modelCache";
const MODEL_CACHE_VERSION = 2;
const MAX_CACHED_MODEL_SETS = 6;

export interface CloudflareModelCacheQuery {
  accountId: string;
  apiKey: string;
  modelFilter: string;
  includeGatewaySupportedModels?: boolean;
  gatewaySupportedModelProviders?: readonly string[];
  manualModels?: readonly unknown[];
  capabilityOverrides?: Record<string, unknown>;
}

export interface CachedCloudflareModels {
  cachedAt: number;
  models: CloudflareModel[];
}

interface StoredCloudflareModelCacheEntry extends CachedCloudflareModels {
  key: string;
  accountId: string;
  modelFilter: string;
  apiKeyFingerprint: string;
  gatewayCatalogDigest: string;
  manualModelsDigest: string;
  capabilityOverridesDigest: string;
}

interface StoredCloudflareModelCache {
  version: number;
  entries: StoredCloudflareModelCacheEntry[];
}

function cloneCloudflareModels(models: readonly CloudflareModel[]): CloudflareModel[] {
  if (typeof globalThis.structuredClone === "function") {
    return globalThis.structuredClone(models) as CloudflareModel[];
  }

  return JSON.parse(JSON.stringify(models)) as CloudflareModel[];
}

function isStoredCloudflareModelCacheEntry(
  value: unknown,
): value is StoredCloudflareModelCacheEntry {
  if (!value || typeof value !== "object") {
    return false;
  }

  const entry = value as Partial<StoredCloudflareModelCacheEntry>;
  return (
    typeof entry.key === "string" &&
    typeof entry.accountId === "string" &&
    typeof entry.modelFilter === "string" &&
    typeof entry.apiKeyFingerprint === "string" &&
    typeof entry.gatewayCatalogDigest === "string" &&
    typeof entry.manualModelsDigest === "string" &&
    typeof entry.capabilityOverridesDigest === "string" &&
    typeof entry.cachedAt === "number" &&
    Array.isArray(entry.models)
  );
}

function getEmptyCloudflareModelCache(): StoredCloudflareModelCache {
  return {
    version: MODEL_CACHE_VERSION,
    entries: [],
  };
}

function loadStoredCloudflareModelCache(
  context: vscode.ExtensionContext,
): StoredCloudflareModelCache {
  try {
    const stored = context.workspaceState.get<StoredCloudflareModelCache>(MODEL_CACHE_STATE_KEY);
    if (!stored || typeof stored !== "object") {
      return getEmptyCloudflareModelCache();
    }

    if (stored.version !== MODEL_CACHE_VERSION || !Array.isArray(stored.entries)) {
      return getEmptyCloudflareModelCache();
    }

    return {
      version: MODEL_CACHE_VERSION,
      entries: stored.entries.filter((entry) => isStoredCloudflareModelCacheEntry(entry)),
    };
  } catch (error) {
    logCloudflareError("Failed to load Cloudflare model cache", error);
    return getEmptyCloudflareModelCache();
  }
}

function saveStoredCloudflareModelCache(
  context: vscode.ExtensionContext,
  cache: StoredCloudflareModelCache,
): void {
  try {
    const updateResult = context.workspaceState.update(
      MODEL_CACHE_STATE_KEY,
      cache,
    ) as Thenable<void> | void;

    if (updateResult) {
      void Promise.resolve(updateResult).catch((error: unknown) => {
        logCloudflareError("Failed to save Cloudflare model cache", error);
      });
    }
  } catch (error) {
    logCloudflareError("Failed to save Cloudflare model cache", error);
  }
}

function getCloudflareModelCacheLookup(query: CloudflareModelCacheQuery): {
  key: string;
  accountId: string;
  modelFilter: string;
  apiKeyFingerprint: string;
  gatewayCatalogDigest: string;
  manualModelsDigest: string;
  capabilityOverridesDigest: string;
} {
  const accountId = query.accountId.trim();
  const modelFilter = query.modelFilter;
  const apiKeyFingerprint = computeStringFingerprint(query.apiKey.trim());
  const gatewayCatalogDigest = computeStringFingerprint(
    stableSerialize({
      includeGatewaySupportedModels: query.includeGatewaySupportedModels ?? false,
      gatewaySupportedModelProviders: query.gatewaySupportedModelProviders ?? [],
    }),
  );
  const manualModelsDigest = computeStringFingerprint(stableSerialize(query.manualModels ?? []));
  const capabilityOverridesDigest = computeStringFingerprint(
    stableSerialize(query.capabilityOverrides ?? {}),
  );

  return {
    key: stableSerialize({
      accountId,
      modelFilter,
      apiKeyFingerprint,
      gatewayCatalogDigest,
      manualModelsDigest,
      capabilityOverridesDigest,
    }),
    accountId,
    modelFilter,
    apiKeyFingerprint,
    gatewayCatalogDigest,
    manualModelsDigest,
    capabilityOverridesDigest,
  };
}

export function loadCachedCloudflareModels(
  context: vscode.ExtensionContext,
  query: CloudflareModelCacheQuery,
): CachedCloudflareModels | undefined {
  const cache = loadStoredCloudflareModelCache(context);
  const lookup = getCloudflareModelCacheLookup(query);
  const entry = cache.entries.find((candidate) => candidate.key === lookup.key);

  if (!entry) {
    return undefined;
  }

  return {
    cachedAt: entry.cachedAt,
    models: cloneCloudflareModels(entry.models),
  };
}

export function saveCachedCloudflareModels(
  context: vscode.ExtensionContext,
  query: CloudflareModelCacheQuery,
  models: readonly CloudflareModel[],
): void {
  const lookup = getCloudflareModelCacheLookup(query);
  const cache = loadStoredCloudflareModelCache(context);
  const entry: StoredCloudflareModelCacheEntry = {
    ...lookup,
    cachedAt: Date.now(),
    models: cloneCloudflareModels(models),
  };

  const nextEntries = cache.entries.filter((candidate) => candidate.key !== lookup.key);
  nextEntries.unshift(entry);

  if (nextEntries.length > MAX_CACHED_MODEL_SETS) {
    nextEntries.length = MAX_CACHED_MODEL_SETS;
  }

  saveStoredCloudflareModelCache(context, {
    version: MODEL_CACHE_VERSION,
    entries: nextEntries,
  });
}
