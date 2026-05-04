import * as vscode from "vscode";
import { base64ToBytes, bytesToBase64 } from "./byte-utils";
import { isCloudflareCompatModelHandle, toCloudflareCompatModelHandle } from "./cloudflare-client";
import { recordCloudflareRequestMetric } from "./request-metrics";

export interface CloudflareRequestState {
  accountId: string;
  apiKey: string;
  gatewayId?: string;
}

export interface CloudflareTextContentPart {
  type: "text";
  text: string;
}

export interface CloudflareImageContentPart {
  type: "image_url";
  image_url: {
    url: string;
  };
}

export interface CloudflareAudioContentPart {
  type: "input_audio";
  input_audio: {
    data: string; // base64-encoded audio
    format: "wav" | "mp3";
  };
}

export type CloudflareMessageContentPart =
  | CloudflareTextContentPart
  | CloudflareImageContentPart
  | CloudflareAudioContentPart;

export interface CloudflareChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string | readonly CloudflareMessageContentPart[];
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
export type CloudflareEndpointKind = "gateway" | "direct";
export type CloudflareDeliveryMode = "event-stream" | "buffered-json";
type CloudflareEndpointApi = "workers-ai" | "compat";

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

export interface CloudflareResponseTextPart {
  type: "text";
  value: string;
}

export interface CloudflareResponseThinkingPart {
  type: "thinking";
  value: string;
}

export interface CloudflareResponseDataPart {
  type: "data";
  data: Uint8Array;
  mimeType: string;
}

export interface CloudflareResponseToolCallPart {
  type: "tool-call";
  toolCall: CloudflareToolCallPart;
}

export type CloudflareResponsePart =
  | CloudflareResponseTextPart
  | CloudflareResponseThinkingPart
  | CloudflareResponseDataPart
  | CloudflareResponseToolCallPart;

export interface CloudflareUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface CloudflareResponseMetrics {
  endpointKind: CloudflareEndpointKind;
  deliveryMode: CloudflareDeliveryMode;
  requestedStream: boolean;
  gatewayFallbackToDirect: boolean;
  totalDurationMs: number;
  timeToFirstTextMs?: number;
}

export interface CloudflareChatResponse {
  parts: CloudflareResponsePart[];
  text?: string;
  toolCalls?: CloudflareToolCallPart[];
  usage?: CloudflareUsage;
  metrics?: CloudflareResponseMetrics;
}

interface CloudflareTextResponse {
  result?: {
    response?: string;
    output_text?: string;
    content?: unknown;
    choices?: unknown;
    tool_calls?: unknown;
    function_call?: unknown;
    usage?: unknown;
  };
  response?: string;
  output_text?: string;
  content?: unknown;
  choices?: unknown;
  tool_calls?: unknown;
  function_call?: unknown;
  usage?: unknown;
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
  stream?: boolean;
  onTextChunk?: (text: string) => void;
  onThinkingChunk?: (text: string) => void;
}

interface CloudflareEndpointTarget {
  kind: CloudflareEndpointKind;
  url: string;
  api: CloudflareEndpointApi;
}

interface CloudflareStreamingAccumulator {
  parts: CloudflareResponsePart[];
  text: string;
  thinkingText: string;
  usage?: CloudflareUsage;
  timeToFirstTextMs?: number;
  readonly requestStartedAtMs: number;
  readonly seenDataPartSignatures: Set<string>;
  readonly seenToolCallSignatures: Set<string>;
  readonly pendingToolCalls: Map<string, PendingStreamingToolCall>;
}

interface PendingStreamingToolCall {
  key: string;
  callId?: string;
  name?: string;
  rawArguments: string;
  input?: object;
  emitted: boolean;
}

interface StreamingToolCallUpdate {
  key: string;
  callId?: string;
  name?: string;
  argumentsText?: string;
  input?: object;
}

const JSON_MIME_TYPE = "application/json";
const TEXT_MIME_TYPE = "text/plain";
const REASONING_MIME_TYPE = "text/x-cloudflare-reasoning";

function encodeText(value: string): Uint8Array {
  return new TextEncoder().encode(value);
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

function isDirectWorkersAiHandle(modelHandle: string): boolean {
  const normalizedHandle = modelHandle.trim();
  return normalizedHandle.startsWith("@") || normalizedHandle.startsWith("workers-ai/@");
}

function toDirectWorkersAiHandle(modelHandle: string): string {
  const normalizedHandle = modelHandle.trim();
  if (normalizedHandle.startsWith("workers-ai/@")) {
    return normalizedHandle.slice("workers-ai/".length);
  }

  return normalizedHandle;
}

function shouldUseCompatEndpoint(modelHandle: string, state: CloudflareRequestState): boolean {
  return Boolean(state.gatewayId) || isCloudflareCompatModelHandle(modelHandle);
}

function buildGatewayEndpoint(state: CloudflareRequestState): string {
  return `https://gateway.ai.cloudflare.com/v1/${state.accountId}/${state.gatewayId ?? "default"}/compat/chat/completions`;
}

function buildDirectEndpoint(modelHandle: string, state: CloudflareRequestState): string {
  return `https://api.cloudflare.com/client/v4/accounts/${state.accountId}/ai/run/${toDirectWorkersAiHandle(modelHandle)}`;
}

function buildCloudflareEndpointTargets(
  modelHandle: string,
  state: CloudflareRequestState,
): {
  primaryTarget: CloudflareEndpointTarget;
  fallbackTarget?: CloudflareEndpointTarget;
} {
  if (shouldUseCompatEndpoint(modelHandle, state)) {
    return {
      primaryTarget: {
        kind: "gateway",
        url: buildGatewayEndpoint(state),
        api: "compat",
      },
      fallbackTarget:
        state.gatewayId && isDirectWorkersAiHandle(modelHandle)
          ? {
              kind: "direct",
              url: buildDirectEndpoint(modelHandle, state),
              api: "workers-ai",
            }
          : undefined,
    };
  }

  return {
    primaryTarget: {
      kind: "direct",
      url: buildDirectEndpoint(modelHandle, state),
      api: "workers-ai",
    },
  };
}

export function buildCloudflareEndpoint(
  modelHandle: string,
  state: CloudflareRequestState,
): string {
  return buildCloudflareEndpointTargets(modelHandle, state).primaryTarget.url;
}

function buildCloudflareHeaders(
  state: CloudflareRequestState,
  target: CloudflareEndpointTarget,
): Record<string, string> {
  const bearerToken = `Bearer ${state.apiKey}`;
  const headers: Record<string, string> = {
    Authorization: bearerToken,
    "Content-Type": "application/json",
  };

  if (target.kind === "gateway" && target.api === "workers-ai") {
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

  const parts = extractCloudflareResponseParts(parsed, trimEnd);
  const text = extractCloudflareText(parsed) ?? joinResponseText(parts);
  if (text !== undefined && !parts.some((part) => part.type === "text")) {
    parts.unshift({
      type: "text",
      value: trimEnd ? text.trimEnd() : text,
    });
  }
  const toolCalls = extractCloudflareToolCalls(parsed);
  const usage = extractCloudflareUsage(parsed);

  if (parts.length > 0 || text !== undefined || (toolCalls && toolCalls.length > 0)) {
    return {
      parts,
      text: text === undefined ? undefined : trimEnd ? text.trimEnd() : text,
      toolCalls,
      usage,
    };
  }

  throw new Error(`Cloudflare ${errorLabel} response did not include textual output: ${raw}`);
}

function isEventStreamResponse(response: Response): boolean {
  const contentType = response.headers.get("content-type");
  return contentType?.toLowerCase().includes("text/event-stream") === true;
}

function createStreamingAccumulator(requestStartedAtMs: number): CloudflareStreamingAccumulator {
  return {
    parts: [],
    text: "",
    thinkingText: "",
    requestStartedAtMs,
    seenDataPartSignatures: new Set<string>(),
    seenToolCallSignatures: new Set<string>(),
    pendingToolCalls: new Map<string, PendingStreamingToolCall>(),
  };
}

function mergeCloudflareUsage(
  current: CloudflareUsage | undefined,
  next: CloudflareUsage | undefined,
): CloudflareUsage | undefined {
  if (!next) {
    return current;
  }

  return {
    promptTokens: next.promptTokens ?? current?.promptTokens,
    completionTokens: next.completionTokens ?? current?.completionTokens,
    totalTokens: next.totalTokens ?? current?.totalTokens,
  };
}

function getStreamedTextDelta(currentText: string, candidateText: string): string {
  if (candidateText.length === 0) {
    return "";
  }

  if (currentText.length === 0) {
    return candidateText;
  }

  if (candidateText === currentText) {
    return "";
  }

  if (candidateText.startsWith(currentText)) {
    return candidateText.slice(currentText.length);
  }

  return candidateText;
}

function emitStreamedText(
  accumulator: CloudflareStreamingAccumulator,
  candidateText: string | undefined,
  options: RequestCloudflareChatTextOptions,
): void {
  if (!candidateText || candidateText.length === 0) {
    return;
  }

  const delta = getStreamedTextDelta(accumulator.text, candidateText);
  if (delta.length === 0) {
    return;
  }

  if (accumulator.timeToFirstTextMs === undefined) {
    accumulator.timeToFirstTextMs = Math.max(0, Date.now() - accumulator.requestStartedAtMs);
  }

  accumulator.parts.push({ type: "text", value: delta });
  accumulator.text += delta;
  options.onTextChunk?.(delta);
}

function emitStreamedThinking(
  accumulator: CloudflareStreamingAccumulator,
  candidateText: string | undefined,
  options: RequestCloudflareChatTextOptions,
): void {
  if (!candidateText || candidateText.length === 0) {
    return;
  }

  const delta = getStreamedTextDelta(accumulator.thinkingText, candidateText);
  if (delta.length === 0) {
    return;
  }

  accumulator.parts.push({ type: "thinking", value: delta });
  accumulator.thinkingText += delta;
  options.onThinkingChunk?.(delta);
}

function withResponseMetrics(
  response: CloudflareChatResponse,
  metrics: CloudflareResponseMetrics,
): CloudflareChatResponse {
  return {
    ...response,
    metrics,
  };
}

function withRequestDuration(
  response: CloudflareChatResponse,
  requestStartedAtMs: number,
): CloudflareChatResponse {
  if (!response.metrics) {
    return response;
  }

  return withResponseMetrics(response, {
    ...response.metrics,
    totalDurationMs: Math.max(0, Date.now() - requestStartedAtMs),
  });
}

function getRecordedErrorMessage(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string" && error.length > 0) {
    return error;
  }

  return undefined;
}

function recordResponseMetrics(
  context: vscode.ExtensionContext,
  response: CloudflareChatResponse,
  options: RequestCloudflareChatTextOptions,
  requestStartedAtMs: number,
): CloudflareChatResponse {
  const responseWithDuration = withRequestDuration(response, requestStartedAtMs);
  if (!responseWithDuration.metrics) {
    return responseWithDuration;
  }

  recordCloudflareRequestMetric(context, {
    accountId: options.state.accountId,
    recordedAt: Date.now(),
    outcome: "success",
    requestKind: options.errorLabel,
    modelHandle: options.modelHandle,
    endpointKind: responseWithDuration.metrics.endpointKind,
    deliveryMode: responseWithDuration.metrics.deliveryMode,
    requestedStream: responseWithDuration.metrics.requestedStream,
    gatewayFallbackToDirect: responseWithDuration.metrics.gatewayFallbackToDirect,
    totalDurationMs: responseWithDuration.metrics.totalDurationMs,
    timeToFirstTextMs: responseWithDuration.metrics.timeToFirstTextMs,
    usage: responseWithDuration.usage
      ? {
          promptTokens: responseWithDuration.usage.promptTokens,
          completionTokens: responseWithDuration.usage.completionTokens,
          totalTokens: responseWithDuration.usage.totalTokens,
        }
      : undefined,
  });

  return responseWithDuration;
}

function recordFailedResponseMetrics(
  context: vscode.ExtensionContext,
  options: RequestCloudflareChatTextOptions,
  endpointKind: CloudflareEndpointKind,
  requestStartedAtMs: number,
  gatewayFallbackToDirect: boolean,
  error: unknown,
): void {
  recordCloudflareRequestMetric(context, {
    accountId: options.state.accountId,
    recordedAt: Date.now(),
    outcome: "error",
    requestKind: options.errorLabel,
    modelHandle: options.modelHandle,
    endpointKind,
    deliveryMode: "unknown",
    requestedStream: options.stream === true,
    gatewayFallbackToDirect,
    totalDurationMs: Math.max(0, Date.now() - requestStartedAtMs),
    errorStatus: error instanceof CloudflareRequestError ? error.status : undefined,
    errorMessage: getRecordedErrorMessage(error),
  });
}

function recordCancelledResponseMetrics(
  context: vscode.ExtensionContext,
  options: RequestCloudflareChatTextOptions,
  endpointKind: CloudflareEndpointKind,
  requestStartedAtMs: number,
  gatewayFallbackToDirect: boolean,
): void {
  recordCloudflareRequestMetric(context, {
    accountId: options.state.accountId,
    recordedAt: Date.now(),
    outcome: "cancelled",
    requestKind: options.errorLabel,
    modelHandle: options.modelHandle,
    endpointKind,
    deliveryMode: "unknown",
    requestedStream: options.stream === true,
    gatewayFallbackToDirect,
    totalDurationMs: Math.max(0, Date.now() - requestStartedAtMs),
  });
}

function getDataPartSignature(part: CloudflareResponseDataPart): string {
  return `${part.mimeType}:${bytesToBase64(part.data)}`;
}

function getToolCallSignature(part: CloudflareResponseToolCallPart): string {
  return `${part.toolCall.callId}:${part.toolCall.name}:${JSON.stringify(part.toolCall.input)}`;
}

function mergeStreamedToolArguments(current: string, next: string): string {
  if (next.length === 0) {
    return current;
  }

  if (current.length === 0) {
    return next;
  }

  if (next === current) {
    return current;
  }

  if (next.startsWith(current)) {
    return next;
  }

  return current + next;
}

function tryParseToolCallArguments(value: string): object | undefined {
  if (value.trim().length === 0) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as object;
    }

    return { value: parsed };
  } catch {
    return undefined;
  }
}

function emitResolvedStreamingToolCall(
  accumulator: CloudflareStreamingAccumulator,
  pendingToolCall: PendingStreamingToolCall,
  force: boolean,
): void {
  if (pendingToolCall.emitted || !pendingToolCall.name) {
    return;
  }

  const input = pendingToolCall.input ?? tryParseToolCallArguments(pendingToolCall.rawArguments);
  if (!input) {
    return;
  }

  if (!pendingToolCall.callId && !force) {
    return;
  }

  const part: CloudflareResponseToolCallPart = {
    type: "tool-call",
    toolCall: {
      callId: pendingToolCall.callId ?? `cf_stream_tool_call_${pendingToolCall.key}`,
      name: pendingToolCall.name,
      input,
    },
  };
  const signature = getToolCallSignature(part);
  if (accumulator.seenToolCallSignatures.has(signature)) {
    pendingToolCall.emitted = true;
    return;
  }

  accumulator.seenToolCallSignatures.add(signature);
  accumulator.parts.push(part);
  pendingToolCall.emitted = true;
}

function applyStreamingToolCallUpdate(
  accumulator: CloudflareStreamingAccumulator,
  update: StreamingToolCallUpdate,
): void {
  const pendingToolCall = accumulator.pendingToolCalls.get(update.key) ?? {
    key: update.key,
    rawArguments: "",
    emitted: false,
  };

  if (update.callId) {
    pendingToolCall.callId = update.callId;
  }

  if (update.name) {
    pendingToolCall.name = update.name;
  }

  if (update.input) {
    pendingToolCall.input = update.input;
  }

  if (update.argumentsText !== undefined) {
    pendingToolCall.rawArguments = mergeStreamedToolArguments(
      pendingToolCall.rawArguments,
      update.argumentsText,
    );
  }

  accumulator.pendingToolCalls.set(update.key, pendingToolCall);
  emitResolvedStreamingToolCall(accumulator, pendingToolCall, false);
}

function flushPendingStreamingToolCalls(accumulator: CloudflareStreamingAccumulator): void {
  for (const pendingToolCall of accumulator.pendingToolCalls.values()) {
    emitResolvedStreamingToolCall(accumulator, pendingToolCall, true);
  }
}

function getStreamingToolCallKey(
  toolCallRecord: Record<string, unknown>,
  index: number,
  source: string,
): string {
  if (typeof toolCallRecord.index === "number") {
    return `${source}:index:${toolCallRecord.index}`;
  }

  if (typeof toolCallRecord.id === "string" && toolCallRecord.id.length > 0) {
    return toolCallRecord.id;
  }

  return `${source}:index:${index}`;
}

function readStreamingToolCallArray(value: unknown, source: string): StreamingToolCallUpdate[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((toolCall, index) => {
    const toolCallRecord = toRecord(toolCall);
    if (!toolCallRecord) {
      return [];
    }

    const functionRecord = toRecord(toolCallRecord.function);
    const key = getStreamingToolCallKey(toolCallRecord, index, source);
    const name = typeof functionRecord?.name === "string" ? functionRecord.name : undefined;
    const rawArguments = functionRecord?.arguments;
    const argumentsText = typeof rawArguments === "string" ? rawArguments : undefined;
    const input =
      rawArguments && typeof rawArguments === "object" ? (rawArguments as object) : undefined;
    const callId = typeof toolCallRecord.id === "string" ? toolCallRecord.id : undefined;

    return [{ key, callId, name, argumentsText, input }];
  });
}

function readStreamingFunctionCall(value: unknown, source: string): StreamingToolCallUpdate[] {
  const functionCallRecord = toRecord(value);
  if (!functionCallRecord) {
    return [];
  }

  const name = typeof functionCallRecord.name === "string" ? functionCallRecord.name : undefined;
  const rawArguments = functionCallRecord.arguments;
  const argumentsText = typeof rawArguments === "string" ? rawArguments : undefined;
  const input =
    rawArguments && typeof rawArguments === "object" ? (rawArguments as object) : undefined;

  return [
    {
      key: `${source}:function_call`,
      name,
      argumentsText,
      input,
    },
  ];
}

function extractStreamingToolCallUpdates(
  parsed: CloudflareTextResponse,
): StreamingToolCallUpdate[] {
  const updates: StreamingToolCallUpdate[] = [];
  updates.push(...readStreamingToolCallArray(parsed.result?.tool_calls, "result.tool_calls"));
  updates.push(...readStreamingToolCallArray(parsed.tool_calls, "tool_calls"));
  updates.push(...readStreamingFunctionCall(parsed.result?.function_call, "result"));
  updates.push(...readStreamingFunctionCall(parsed.function_call, "root"));

  const topLevelChoices = Array.isArray(parsed.choices) ? parsed.choices : [];
  const resultChoices = Array.isArray(parsed.result?.choices) ? parsed.result.choices : [];
  for (const [choiceIndex, choice] of [...resultChoices, ...topLevelChoices].entries()) {
    const choiceRecord = toRecord(choice);
    if (!choiceRecord) {
      continue;
    }

    const message = toRecord(choiceRecord.message);
    const delta = toRecord(choiceRecord.delta);
    updates.push(
      ...readStreamingToolCallArray(choiceRecord.tool_calls, `choice.${choiceIndex}.tool_calls`),
    );
    updates.push(
      ...readStreamingToolCallArray(
        message?.tool_calls,
        `choice.${choiceIndex}.message.tool_calls`,
      ),
    );
    updates.push(
      ...readStreamingToolCallArray(delta?.tool_calls, `choice.${choiceIndex}.delta.tool_calls`),
    );
    updates.push(...readStreamingFunctionCall(choiceRecord.function_call, `choice.${choiceIndex}`));
    updates.push(
      ...readStreamingFunctionCall(message?.function_call, `choice.${choiceIndex}.message`),
    );
    updates.push(...readStreamingFunctionCall(delta?.function_call, `choice.${choiceIndex}.delta`));
  }

  return updates;
}

function shouldDeferStreamedToolCall(part: CloudflareResponseToolCallPart): boolean {
  const inputRecord = toRecord(part.toolCall.input);
  if (!inputRecord || Object.keys(inputRecord).length !== 1 || !("value" in inputRecord)) {
    return false;
  }

  const rawValue = inputRecord.value;
  if (typeof rawValue !== "string") {
    return false;
  }

  const trimmed = rawValue.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function emitStreamedNonTextPart(
  accumulator: CloudflareStreamingAccumulator,
  part: CloudflareResponseDataPart | CloudflareResponseToolCallPart,
): void {
  if (part.type === "data") {
    const signature = getDataPartSignature(part);
    if (accumulator.seenDataPartSignatures.has(signature)) {
      return;
    }

    accumulator.seenDataPartSignatures.add(signature);
    accumulator.parts.push(part);
    return;
  }

  if (shouldDeferStreamedToolCall(part)) {
    return;
  }

  const signature = getToolCallSignature(part);
  if (accumulator.seenToolCallSignatures.has(signature)) {
    return;
  }

  accumulator.seenToolCallSignatures.add(signature);
  accumulator.parts.push(part);
}

function processCloudflareStreamingPayload(
  payload: string,
  accumulator: CloudflareStreamingAccumulator,
  options: RequestCloudflareChatTextOptions,
): boolean {
  const trimmedPayload = payload.trim();
  if (trimmedPayload.length === 0) {
    return false;
  }

  if (trimmedPayload === "[DONE]") {
    return true;
  }

  let parsed: CloudflareTextResponse | undefined;
  try {
    parsed = JSON.parse(payload) as CloudflareTextResponse;
  } catch {
    emitStreamedText(accumulator, payload, options);
    return false;
  }

  const eventParts = extractCloudflareResponseParts(parsed, false);
  emitStreamedText(accumulator, joinResponseText(eventParts), options);
  emitStreamedThinking(accumulator, joinResponseThinking(eventParts), options);
  for (const update of extractStreamingToolCallUpdates(parsed)) {
    applyStreamingToolCallUpdate(accumulator, update);
  }

  for (const part of eventParts) {
    if (part.type === "text" || part.type === "thinking") {
      continue;
    }

    emitStreamedNonTextPart(accumulator, part);
  }

  accumulator.usage = mergeCloudflareUsage(accumulator.usage, extractCloudflareUsage(parsed));
  return false;
}

function readServerSentEventPayload(eventBlock: string): string | undefined {
  const dataLines = eventBlock
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /u, ""));

  if (dataLines.length === 0) {
    return undefined;
  }

  return dataLines.join("\n");
}

async function parseCloudflareEventStream(
  response: Response,
  options: RequestCloudflareChatTextOptions,
  endpointKind: CloudflareEndpointKind,
  requestStartedAtMs: number,
): Promise<CloudflareChatResponse> {
  if (!response.body) {
    throw new Error(`Cloudflare ${options.errorLabel} stream response did not include a body.`);
  }

  const accumulator = createStreamingAccumulator(requestStartedAtMs);
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";
  let streamCompleted = false;

  while (!streamCompleted) {
    const { value, done } = await reader.read();
    if (done) {
      buffer += decoder.decode();
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const separatorMatch = /\r?\n\r?\n/u.exec(buffer);
      if (!separatorMatch || separatorMatch.index === undefined) {
        break;
      }

      const eventBlock = buffer.slice(0, separatorMatch.index);
      buffer = buffer.slice(separatorMatch.index + separatorMatch[0].length);
      const payload = readServerSentEventPayload(eventBlock);
      if (!payload) {
        continue;
      }

      streamCompleted = processCloudflareStreamingPayload(payload, accumulator, options);
      if (streamCompleted) {
        break;
      }
    }
  }

  const remainingPayload = readServerSentEventPayload(buffer);
  if (!streamCompleted && remainingPayload) {
    processCloudflareStreamingPayload(remainingPayload, accumulator, options);
  }

  flushPendingStreamingToolCalls(accumulator);

  const text = options.trimEnd === true ? accumulator.text.trimEnd() : accumulator.text;
  if (accumulator.parts.length === 0 && text.length === 0) {
    throw new Error(`Cloudflare ${options.errorLabel} stream did not include textual output.`);
  }

  return withResponseMetrics(
    {
      parts: accumulator.parts,
      text: text.length > 0 ? text : undefined,
      toolCalls: accumulator.parts
        .filter((part): part is CloudflareResponseToolCallPart => part.type === "tool-call")
        .map((part) => part.toolCall),
      usage: accumulator.usage,
    },
    {
      endpointKind,
      deliveryMode: "event-stream",
      requestedStream: options.stream === true,
      gatewayFallbackToDirect: false,
      totalDurationMs: Math.max(0, Date.now() - requestStartedAtMs),
      timeToFirstTextMs: accumulator.timeToFirstTextMs,
    },
  );
}

function finalizeBufferedResponseMetrics(
  response: CloudflareChatResponse,
  options: RequestCloudflareChatTextOptions,
  endpointKind: CloudflareEndpointKind,
  requestStartedAtMs: number,
): CloudflareChatResponse {
  const totalDurationMs = Math.max(0, Date.now() - requestStartedAtMs);

  return withResponseMetrics(response, {
    endpointKind,
    deliveryMode: "buffered-json",
    requestedStream: options.stream === true,
    gatewayFallbackToDirect: false,
    totalDurationMs,
    timeToFirstTextMs: response.text ? totalDurationMs : undefined,
  });
}

function markGatewayFallback(response: CloudflareChatResponse): CloudflareChatResponse {
  if (!response.metrics) {
    return response;
  }

  return withResponseMetrics(response, {
    ...response.metrics,
    gatewayFallbackToDirect: true,
  });
}

function joinResponseText(parts: readonly CloudflareResponsePart[]): string | undefined {
  const text = parts
    .filter((part): part is CloudflareResponseTextPart => part.type === "text")
    .map((part) => part.value)
    .join("");
  return text.length > 0 ? text : undefined;
}

function joinResponseThinking(parts: readonly CloudflareResponsePart[]): string | undefined {
  const text = parts
    .filter((part): part is CloudflareResponseThinkingPart => part.type === "thinking")
    .map((part) => part.value)
    .join("");
  return text.length > 0 ? text : undefined;
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

      const recordType = typeof record.type === "string" ? record.type.toLowerCase() : undefined;
      if (recordType === "reasoning" || recordType === "thinking") {
        return "";
      }

      const text = record.text;
      if (typeof text === "string") {
        return text;
      }

      const summary = record.summary;
      if (typeof summary === "string") {
        return summary;
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

function normalizeMimeType(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function toUint8Array(value: unknown, mimeType: string): Uint8Array | undefined {
  if (value instanceof Uint8Array) {
    return value;
  }

  if (typeof value === "string") {
    if (mimeType.startsWith("text/") || mimeType.includes("json")) {
      return encodeText(value);
    }

    return base64ToBytes(value);
  }

  if (Array.isArray(value) && value.every((item) => typeof item === "number")) {
    return Uint8Array.from(value);
  }

  return undefined;
}

function createDataResponsePart(data: Uint8Array, mimeType: string): CloudflareResponseDataPart {
  return {
    type: "data",
    data,
    mimeType,
  };
}

function readReasoningContent(record: Record<string, unknown>): string | undefined {
  const candidates: unknown[] = [record.text, record.summary, record.reasoning, record.thinking];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }

  const content = record.content;
  return typeof content === "string" && content.trim().length > 0 ? content : undefined;
}

function readJsonPayload(record: Record<string, unknown>): unknown {
  if ("json" in record) {
    return record.json;
  }

  const mimeType = typeof record.mimeType === "string" ? record.mimeType : record.mime_type;
  if (
    typeof mimeType === "string" &&
    mimeType.includes("json") &&
    ("value" in record || "data" in record)
  ) {
    return record.value ?? record.data;
  }

  return undefined;
}

function readThinkingFieldText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.length > 0 ? value : undefined;
  }

  if (Array.isArray(value)) {
    const joined = value.map((item) => readThinkingFieldText(item) ?? "").join("");
    return joined.length > 0 ? joined : undefined;
  }

  const record = toRecord(value);
  if (!record) {
    return undefined;
  }

  const text =
    (typeof record.text === "string" ? record.text : undefined) ??
    (typeof record.value === "string" ? record.value : undefined) ??
    (typeof record.content === "string" ? record.content : undefined);
  return text && text.length > 0 ? text : undefined;
}

function toResponseParts(value: unknown): CloudflareResponsePart[] {
  if (typeof value === "string") {
    return value.length > 0 ? [{ type: "text", value }] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => toResponseParts(item));
  }

  const record = toRecord(value);
  if (!record) {
    return [];
  }

  const recordType = typeof record.type === "string" ? record.type.toLowerCase() : undefined;
  if (recordType === "reasoning" || recordType === "thinking") {
    const reasoning = readReasoningContent(record);
    return reasoning ? [createDataResponsePart(encodeText(reasoning), REASONING_MIME_TYPE)] : [];
  }

  const jsonPayload = readJsonPayload(record);
  if (jsonPayload !== undefined) {
    const jsonText = typeof jsonPayload === "string" ? jsonPayload : JSON.stringify(jsonPayload);
    return [createDataResponsePart(encodeText(jsonText), JSON_MIME_TYPE)];
  }

  const mimeType = normalizeMimeType(record.mimeType ?? record.mime_type, TEXT_MIME_TYPE);
  if ("data" in record) {
    const data = toUint8Array(record.data, mimeType);
    if (data) {
      return [createDataResponsePart(data, mimeType)];
    }
  }

  const text =
    readMessageContent(record.content) ??
    (typeof record.text === "string" ? record.text : undefined) ??
    (typeof record.value === "string" ? record.value : undefined);
  return text && text.length > 0 ? [{ type: "text", value: text }] : [];
}

function extractCloudflareResponseParts(
  parsed: CloudflareTextResponse,
  trimEnd: boolean,
): CloudflareResponsePart[] {
  const parts: CloudflareResponsePart[] = [];
  const candidates: unknown[] = [parsed.result?.content, parsed.content];
  const thinkingCandidates: unknown[] = [];

  const topLevelChoices = Array.isArray(parsed.choices) ? parsed.choices : [];
  const resultChoices = Array.isArray(parsed.result?.choices) ? parsed.result.choices : [];
  for (const choice of [...resultChoices, ...topLevelChoices]) {
    const choiceRecord = toRecord(choice);
    if (!choiceRecord) {
      continue;
    }

    candidates.push(choiceRecord.content);
    candidates.push(toRecord(choiceRecord.message)?.content);
    candidates.push(toRecord(choiceRecord.delta)?.content);
    thinkingCandidates.push(toRecord(choiceRecord.message)?.reasoning);
    thinkingCandidates.push(toRecord(choiceRecord.delta)?.reasoning);
    thinkingCandidates.push(toRecord(choiceRecord.message)?.thinking);
    thinkingCandidates.push(toRecord(choiceRecord.delta)?.thinking);
  }

  for (const candidate of candidates) {
    const candidateParts = toResponseParts(candidate);
    for (const part of candidateParts) {
      if (part.type === "text" && trimEnd) {
        parts.push({ type: "text", value: part.value.trimEnd() });
      } else {
        parts.push(part);
      }
    }
  }

  for (const candidate of thinkingCandidates) {
    const thinkingText = readThinkingFieldText(candidate);
    if (thinkingText && thinkingText.length > 0) {
      parts.push({
        type: "thinking",
        value: trimEnd ? thinkingText.trimEnd() : thinkingText,
      });
    }
  }

  const textParts = parts.filter(
    (part): part is CloudflareResponseTextPart => part.type === "text" && part.value.length > 0,
  );
  if (parts.length === 0 && textParts.length === 0) {
    const fallbackText = extractCloudflareText(parsed);
    if (fallbackText) {
      parts.push({
        type: "text",
        value: trimEnd ? fallbackText.trimEnd() : fallbackText,
      });
    }
  }

  const toolCalls = extractCloudflareToolCalls(parsed) ?? [];
  for (const toolCall of toolCalls) {
    parts.push({ type: "tool-call", toolCall });
  }

  return parts.filter((part) => part.type !== "text" || part.value.length > 0);
}

function extractCloudflareUsage(parsed: CloudflareTextResponse): CloudflareUsage | undefined {
  const usageRecord = toRecord(parsed.result?.usage) ?? toRecord(parsed.usage);
  if (!usageRecord) {
    return undefined;
  }

  const promptTokens =
    typeof usageRecord.prompt_tokens === "number"
      ? usageRecord.prompt_tokens
      : typeof usageRecord.promptTokens === "number"
        ? usageRecord.promptTokens
        : undefined;
  const completionTokens =
    typeof usageRecord.completion_tokens === "number"
      ? usageRecord.completion_tokens
      : typeof usageRecord.completionTokens === "number"
        ? usageRecord.completionTokens
        : undefined;
  const totalTokens =
    typeof usageRecord.total_tokens === "number"
      ? usageRecord.total_tokens
      : typeof usageRecord.totalTokens === "number"
        ? usageRecord.totalTokens
        : undefined;

  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) {
    return undefined;
  }

  return {
    promptTokens,
    completionTokens,
    totalTokens,
  };
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
  const requestStartedAtMs = Date.now();
  const body: Record<string, unknown> = {
    messages: options.messages,
  };

  if (target.api === "compat") {
    body.model = toCloudflareCompatModelHandle(options.modelHandle);
  }

  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools;
    body.tool_choice = options.toolChoice ?? "auto";
    body.parallel_tool_calls = true;
  }

  if (options.stream) {
    body.stream = true;
  }

  let response: Response | undefined;
  let retries = 0;
  const maxRetries = 3;

  while (true) {
    response = await fetch(target.url, {
      method: "POST",
      headers: buildCloudflareHeaders(options.state, target),
      body: JSON.stringify(body),
      signal,
    });

    if (
      !response.ok &&
      (response.status === 429 ||
        response.status === 502 ||
        response.status === 503 ||
        response.status === 504) &&
      retries < maxRetries &&
      !signal.aborted
    ) {
      retries++;
      const delayMs = Math.pow(2, retries) * 500 + Math.random() * 200;
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, delayMs);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timeout);
            resolve();
          },
          { once: true },
        );
      });
      if (signal.aborted) {
        throw new DOMException("The user aborted a request.", "AbortError");
      }
      continue;
    }
    break;
  }

  if (response.ok && isEventStreamResponse(response)) {
    return parseCloudflareEventStream(response, options, target.kind, requestStartedAtMs);
  }

  const raw = await response.text();
  if (!response.ok) {
    throw new CloudflareRequestError(target.kind, response.status, raw, options.errorLabel);
  }

  const parsed = parseCloudflareChatResponse(raw, options.errorLabel, options.trimEnd === true);
  if (options.onTextChunk) {
    for (const part of parsed.parts) {
      if (part.type === "text") {
        options.onTextChunk(part.value);
      }
    }
  }

  return finalizeBufferedResponseMetrics(parsed, options, target.kind, requestStartedAtMs);
}

export async function requestCloudflareChatResponse(
  context: vscode.ExtensionContext,
  options: RequestCloudflareChatTextOptions,
): Promise<CloudflareChatResponse | undefined> {
  const requestStartedAtMs = Date.now();
  const { primaryTarget, fallbackTarget } = buildCloudflareEndpointTargets(
    options.modelHandle,
    options.state,
  );
  let activeEndpointKind: CloudflareEndpointKind = primaryTarget.kind;
  let gatewayFallbackToDirect = false;

  if (options.token.isCancellationRequested) {
    recordCancelledResponseMetrics(
      context,
      options,
      activeEndpointKind,
      requestStartedAtMs,
      gatewayFallbackToDirect,
    );
    return undefined;
  }

  const abortController = new AbortController();
  const cancellationDisposable = options.token.onCancellationRequested(() =>
    abortController.abort(),
  );

  try {
    if (primaryTarget.kind === "direct") {
      activeEndpointKind = "direct";
      return recordResponseMetrics(
        context,
        await requestCloudflareEndpoint(options, primaryTarget, abortController.signal),
        options,
        requestStartedAtMs,
      );
    }

    try {
      activeEndpointKind = "gateway";
      return recordResponseMetrics(
        context,
        await requestCloudflareEndpoint(options, primaryTarget, abortController.signal),
        options,
        requestStartedAtMs,
      );
    } catch (gatewayError) {
      if (
        !(isCloudflareRequestError(gatewayError) && gatewayError.status === 401) ||
        !fallbackTarget
      ) {
        throw gatewayError;
      }

      try {
        activeEndpointKind = "direct";
        gatewayFallbackToDirect = true;
        const directResponse = await requestCloudflareEndpoint(
          options,
          fallbackTarget,
          abortController.signal,
        );
        return recordResponseMetrics(
          context,
          markGatewayFallback(directResponse),
          options,
          requestStartedAtMs,
        );
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
      recordCancelledResponseMetrics(
        context,
        options,
        activeEndpointKind,
        requestStartedAtMs,
        gatewayFallbackToDirect,
      );
      return undefined;
    }

    recordFailedResponseMetrics(
      context,
      options,
      activeEndpointKind,
      requestStartedAtMs,
      gatewayFallbackToDirect,
      error,
    );
    throw error;
  } finally {
    cancellationDisposable.dispose();
  }
}

export async function requestCloudflareChatText(
  context: vscode.ExtensionContext,
  options: RequestCloudflareChatTextOptions,
): Promise<string | undefined> {
  const response = await requestCloudflareChatResponse(context, options);
  return response?.text;
}
