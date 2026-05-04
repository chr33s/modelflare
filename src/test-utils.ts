import * as vscode from "vscode";

export type MockFetchImpl = (url: string | URL, init?: RequestInit) => Promise<Response>;

type MutableGlobal = typeof globalThis & {
  fetch: typeof fetch;
};

function getMutableGlobal(): MutableGlobal {
  return globalThis as MutableGlobal;
}

export function saveGlobalFetch(): typeof fetch {
  return getMutableGlobal().fetch;
}

export function restoreGlobalFetch(savedFetch: typeof fetch): void {
  getMutableGlobal().fetch = savedFetch;
}

export function mockFetch(impl: MockFetchImpl): void {
  getMutableGlobal().fetch = impl as typeof fetch;
}

export function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function makeTextResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}

export function makeSseResponse(events: string[], status = 200): Response {
  const body = [...events.map((event) => `data: ${event}\n\n`), "data: [DONE]\n\n"].join("");
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}

export function createMockExtensionContext(): vscode.ExtensionContext {
  return {
    workspaceState: {
      get: () => undefined,
      update: async () => {},
    },
  } as unknown as vscode.ExtensionContext;
}
