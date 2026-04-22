import * as vscode from "vscode";

export interface CloudflareRequestState {
  accountId: string;
  apiKey: string;
  gatewayId?: string;
}

export interface CloudflareChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_calls?: CloudflareToolCallPayload[];
  tool_call_id?: string;
}

export interface CloudflareToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: object;
  };
}

export type CloudflareToolChoiceMode = "auto" | "required";

export interface CloudflareToolCallPart {
  callId: string;
  name: string;
  input: object;
}

interface CloudflareToolCallPayload {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface CloudflareChatResponse {
  text?: string;
  toolCalls?: CloudflareToolCallPart[];
}

interface CloudflareTextResponse {
  result?: {
    response?: string;
    output_text?: string;
    choices?: unknown;
    tool_calls?: unknown;
    function_call?: unknown;
  };
  response?: string;
  output_text?: string;
  choices?: unknown;
  tool_calls?: unknown;
  function_call?: unknown;
}

interface RequestCloudflareChatTextOptions {
  modelHandle: string;
  state: CloudflareRequestState;
  messages: readonly CloudflareChatMessage[];
  tools?: readonly CloudflareToolDefinition[];
  toolChoice?: CloudflareToolChoiceMode;
  token: vscode.CancellationToken;
  errorLabel: string;
  trimEnd?: boolean;
}

type CloudflareEndpointKind = "gateway" | "direct";

interface CloudflareEndpointTarget {
  kind: CloudflareEndpointKind;
  url: string;
}

class CloudflareRequestError extends Error {
  readonly status: number;
  readonly raw: string;
  readonly endpointKind: CloudflareEndpointKind;

  constructor(
    endpointKind: CloudflareEndpointKind,
    status: number,
    raw: string,
    errorLabel: string,
  ) {
    super(`Cloudflare ${errorLabel} request failed (${status}) via ${endpointKind}: ${raw}`);
    this.name = "CloudflareRequestError";
    this.status = status;
    this.raw = raw;
    this.endpointKind = endpointKind;
  }
}

function isCloudflareRequestError(error: unknown): error is CloudflareRequestError {
  return error instanceof CloudflareRequestError;
}

function buildGatewayEndpoint(modelHandle: string, state: CloudflareRequestState): string {
  return `https://gateway.ai.cloudflare.com/v1/${state.accountId}/${state.gatewayId}/workers-ai/${modelHandle}`;
}

function buildDirectEndpoint(modelHandle: string, state: CloudflareRequestState): string {
  return `https://api.cloudflare.com/client/v4/accounts/${state.accountId}/ai/run/${modelHandle}`;
}

export function buildCloudflareEndpoint(
  modelHandle: string,
  state: CloudflareRequestState,
): string {
  if (state.gatewayId) {
    return buildGatewayEndpoint(modelHandle, state);
  }

  return buildDirectEndpoint(modelHandle, state);
}

function buildCloudflareHeaders(
  state: CloudflareRequestState,
  endpointKind: CloudflareEndpointKind,
): Record<string, string> {
  const bearerToken = `Bearer ${state.apiKey}`;
  const headers: Record<string, string> = {
    Authorization: bearerToken,
    "Content-Type": "application/json",
  };

  if (endpointKind === "gateway") {
    // AI Gateway accepts this header for upstream Workers AI auth.
    headers["cf-aig-authorization"] = bearerToken;
  }

  return headers;
}

function parseCloudflareChatResponse(
  raw: string,
  errorLabel: string,
  trimEnd: boolean,
): CloudflareChatResponse {
  let parsed: CloudflareTextResponse;

  try {
    parsed = JSON.parse(raw) as CloudflareTextResponse;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    throw new Error(`Failed to parse Cloudflare ${errorLabel} response (${message}): ${raw}`);
  }

  const text = extractCloudflareText(parsed);
  const toolCalls = extractCloudflareToolCalls(parsed);

  if (text !== undefined || (toolCalls && toolCalls.length > 0)) {
    return {
      text: text === undefined ? undefined : trimEnd ? text.trimEnd() : text,
      toolCalls,
    };
  }

  throw new Error(`Cloudflare ${errorLabel} response did not include textual output: ${raw}`);
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function readMessageContent(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content.trim().length > 0 ? content : undefined;
  }

  if (!Array.isArray(content)) {
    return undefined;
  }

  const pieces = content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }

      const record = toRecord(part);
      if (!record) {
        return "";
      }

      const text = record.text;
      if (typeof text === "string") {
        return text;
      }

      const value = record.value;
      if (typeof value === "string") {
        return value;
      }

      return "";
    })
    .filter((piece) => piece.length > 0);

  if (pieces.length === 0) {
    return undefined;
  }

  return pieces.join("");
}

function readChoiceText(choices: unknown): string | undefined {
  if (!Array.isArray(choices)) {
    return undefined;
  }

  for (const choice of choices) {
    const choiceRecord = toRecord(choice);
    if (!choiceRecord) {
      continue;
    }

    const directText = choiceRecord.text;
    if (typeof directText === "string" && directText.trim().length > 0) {
      return directText;
    }

    const message = toRecord(choiceRecord.message);
    if (message) {
      const messageText = readMessageContent(message.content);
      if (messageText) {
        return messageText;
      }
    }

    const delta = toRecord(choiceRecord.delta);
    if (delta) {
      const deltaText = readMessageContent(delta.content);
      if (deltaText) {
        return deltaText;
      }
    }
  }

  return undefined;
}

function extractCloudflareText(parsed: CloudflareTextResponse): string | undefined {
  const candidates: Array<unknown> = [
    parsed.result?.response,
    parsed.response,
    parsed.result?.output_text,
    parsed.output_text,
    readChoiceText(parsed.result?.choices),
    readChoiceText(parsed.choices),
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }

  const parsedRecord = toRecord(parsed);
  if (!parsedRecord) {
    return undefined;
  }

  const nestedResult = toRecord(parsedRecord.result);
  if (nestedResult) {
    const nestedResponse = nestedResult.response;
    if (typeof nestedResponse === "string" && nestedResponse.trim().length > 0) {
      return nestedResponse;
    }
  }

  return undefined;
}

function parseToolCallInput(value: unknown): object {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (typeof parsed === "object" && parsed !== null) {
        return parsed as object;
      }
    } catch {
      return { value };
    }

    return { value };
  }

  if (typeof value === "object" && value !== null) {
    return value as object;
  }

  return {};
}

function toToolCallPart(toolCall: unknown, index: number): CloudflareToolCallPart | undefined {
  const toolCallRecord = toRecord(toolCall);
  if (!toolCallRecord) {
    return undefined;
  }

  const functionRecord = toRecord(toolCallRecord.function);
  if (!functionRecord) {
    return undefined;
  }

  const name = functionRecord?.name;
  if (typeof name !== "string" || name.length === 0) {
    return undefined;
  }

  const rawId = toolCallRecord.id;
  const callId =
    typeof rawId === "string" && rawId.length > 0 ? rawId : `cf_tool_call_${Date.now()}_${index}`;
  const input = parseToolCallInput(functionRecord.arguments);

  return {
    callId,
    name,
    input,
  };
}

function readToolCalls(value: unknown): CloudflareToolCallPart[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((toolCall, index) => toToolCallPart(toolCall, index))
    .filter((toolCall): toolCall is CloudflareToolCallPart => toolCall !== undefined);
}

function readFunctionCall(value: unknown): CloudflareToolCallPart[] {
  const functionCallRecord = toRecord(value);
  if (!functionCallRecord) {
    return [];
  }

  const name = functionCallRecord.name;
  if (typeof name !== "string" || name.length === 0) {
    return [];
  }

  return [
    {
      callId: `cf_tool_call_${Date.now()}_0`,
      name,
      input: parseToolCallInput(functionCallRecord.arguments),
    },
  ];
}

function extractCloudflareToolCalls(
  parsed: CloudflareTextResponse,
): CloudflareToolCallPart[] | undefined {
  const candidates: unknown[] = [
    parsed.result?.tool_calls,
    parsed.tool_calls,
    parsed.result?.function_call,
    parsed.function_call,
  ];

  const topLevelChoices = Array.isArray(parsed.choices) ? parsed.choices : [];
  const resultChoices = Array.isArray(parsed.result?.choices) ? parsed.result.choices : [];

  for (const choice of [...resultChoices, ...topLevelChoices]) {
    const choiceRecord = toRecord(choice);
    if (!choiceRecord) {
      continue;
    }

    candidates.push(choiceRecord.tool_calls);
    candidates.push(choiceRecord.function_call);
    candidates.push(toRecord(choiceRecord.message)?.tool_calls);
    candidates.push(toRecord(choiceRecord.message)?.function_call);
    candidates.push(toRecord(choiceRecord.delta)?.tool_calls);
    candidates.push(toRecord(choiceRecord.delta)?.function_call);
  }

  const toolCalls = candidates.flatMap((candidate) => {
    const asToolCalls = readToolCalls(candidate);
    if (asToolCalls.length > 0) {
      return asToolCalls;
    }

    return readFunctionCall(candidate);
  });
  return toolCalls.length > 0 ? toolCalls : undefined;
}

async function requestCloudflareEndpoint(
  options: RequestCloudflareChatTextOptions,
  target: CloudflareEndpointTarget,
  signal: AbortSignal,
): Promise<CloudflareChatResponse> {
  const body: Record<string, unknown> = {
    messages: options.messages,
  };

  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools;
    body.tool_choice = options.toolChoice ?? "auto";
    body.parallel_tool_calls = true;
  }

  const response = await fetch(target.url, {
    method: "POST",
    headers: buildCloudflareHeaders(options.state, target.kind),
    body: JSON.stringify(body),
    signal,
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new CloudflareRequestError(target.kind, response.status, raw, options.errorLabel);
  }

  return parseCloudflareChatResponse(raw, options.errorLabel, options.trimEnd === true);
}

export async function requestCloudflareChatResponse(
  options: RequestCloudflareChatTextOptions,
): Promise<CloudflareChatResponse | undefined> {
  if (options.token.isCancellationRequested) {
    return undefined;
  }

  const endpoint = buildCloudflareEndpoint(options.modelHandle, options.state);
  const abortController = new AbortController();
  const cancellationDisposable = options.token.onCancellationRequested(() =>
    abortController.abort(),
  );

  try {
    const directTarget: CloudflareEndpointTarget = {
      kind: "direct",
      url: buildDirectEndpoint(options.modelHandle, options.state),
    };

    if (!options.state.gatewayId) {
      return await requestCloudflareEndpoint(options, directTarget, abortController.signal);
    }

    const gatewayTarget: CloudflareEndpointTarget = {
      kind: "gateway",
      url: endpoint,
    };

    try {
      return await requestCloudflareEndpoint(options, gatewayTarget, abortController.signal);
    } catch (gatewayError) {
      if (!(isCloudflareRequestError(gatewayError) && gatewayError.status === 401)) {
        throw gatewayError;
      }

      try {
        return await requestCloudflareEndpoint(options, directTarget, abortController.signal);
      } catch (directError) {
        if (isCloudflareRequestError(directError)) {
          throw new Error(
            `Cloudflare ${options.errorLabel} request failed via gateway (401) and direct fallback (${directError.status}): gateway=${gatewayError.raw}; direct=${directError.raw}`,
          );
        }

        throw directError;
      }
    }
  } catch (error) {
    if (
      options.token.isCancellationRequested &&
      error instanceof DOMException &&
      error.name === "AbortError"
    ) {
      return undefined;
    }

    throw error;
  } finally {
    cancellationDisposable.dispose();
  }
}

export async function requestCloudflareChatText(
  options: RequestCloudflareChatTextOptions,
): Promise<string | undefined> {
  const response = await requestCloudflareChatResponse(options);
  return response?.text;
}
