import * as vscode from "vscode";
import { CloudflareModel, getCloudflareModelHandle } from "./cloudflare-client";
import {
  CloudflareChatMessage,
  CloudflareRequestState,
  CloudflareToolChoiceMode,
  CloudflareToolDefinition,
  requestCloudflareChatResponse,
} from "./cloudflare-runtime";

interface ModelPickerCategory {
  readonly label: string;
  readonly order?: number;
  readonly showHeader?: boolean;
}

interface CloudflareLanguageModelChatInformation extends vscode.LanguageModelChatInformation {
  readonly isUserSelectable?: boolean;
  readonly targetChatSessionType?: string;
  readonly category?: ModelPickerCategory;
}

interface ProviderModelInformation extends CloudflareLanguageModelChatInformation {}

export interface RegisteredModelProvider extends vscode.Disposable {
  updateModels(
    models: CloudflareModel[],
    accountId: string,
    apiKey: string,
    gatewayId?: string,
  ): void;
  getRegisteredModels(): readonly ProviderModelInformation[];
}

const TOOL_CALLING_HINTS = ["function calling", "tool calling", "agent capabilities"];
const IMAGE_INPUT_HINTS = ["vision", "multimodal", "image input", "image understanding"];
const TOOL_CALLING_PROPERTY_HINTS = ["function", "tool"];
const IMAGE_INPUT_PROPERTY_HINTS = ["vision", "image", "multimodal"];
const NEGATIVE_PROPERTY_VALUES = ["false", "0", "no", "disabled", "unsupported"];

function getMessageText(message: vscode.LanguageModelChatRequestMessage): string {
  return message.content
    .filter(
      (part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart,
    )
    .map((part: vscode.LanguageModelTextPart) => part.value)
    .join("");
}

function mapRole(role: vscode.LanguageModelChatMessageRole): CloudflareChatMessage["role"] {
  if (role === vscode.LanguageModelChatMessageRole.User) {
    return "user";
  }

  if (role === vscode.LanguageModelChatMessageRole.Assistant) {
    return "assistant";
  }

  return "system";
}

function stringifyUnknownPart(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return value.toString();
  }

  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;

    if (typeof record.value === "string") {
      return record.value;
    }

    if (typeof record.text === "string") {
      return record.text;
    }

    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }

  return "";
}

function toCloudflareToolCallPayload(
  part: vscode.LanguageModelToolCallPart,
): NonNullable<CloudflareChatMessage["tool_calls"]>[number] {
  return {
    id: part.callId,
    type: "function",
    function: {
      name: part.name,
      arguments: JSON.stringify(part.input ?? {}),
    },
  };
}

function serializeToolResultContent(part: vscode.LanguageModelToolResultPart): string {
  const content = part.content
    .map((item) => stringifyUnknownPart(item))
    .join("")
    .trim();
  return content.length > 0 ? content : "{}";
}

export function toCloudflareMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): CloudflareChatMessage[] {
  const cloudflareMessages: CloudflareChatMessage[] = [];

  for (const message of messages) {
    const role = mapRole(message.role);
    const textParts: string[] = [];
    const toolCallParts: vscode.LanguageModelToolCallPart[] = [];
    const toolResultParts: vscode.LanguageModelToolResultPart[] = [];

    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        textParts.push(part.value);
        continue;
      }

      if (part instanceof vscode.LanguageModelToolCallPart) {
        toolCallParts.push(part);
        continue;
      }

      if (part instanceof vscode.LanguageModelToolResultPart) {
        toolResultParts.push(part);
        continue;
      }

      if (typeof part === "string") {
        textParts.push(part);
      }
    }

    const content = textParts.join("");

    if (role === "assistant" && toolCallParts.length > 0) {
      cloudflareMessages.push({
        role,
        content,
        tool_calls: toolCallParts.map((part) => toCloudflareToolCallPayload(part)),
      });
    } else if (content.length > 0) {
      cloudflareMessages.push({
        role,
        content,
      });
    }

    if (role === "user" && toolResultParts.length > 0) {
      for (const part of toolResultParts) {
        cloudflareMessages.push({
          role: "tool",
          tool_call_id: part.callId,
          content: serializeToolResultContent(part),
        });
      }
    }
  }

  return cloudflareMessages;
}

export function toCloudflareTools(
  tools: readonly vscode.LanguageModelChatTool[] | undefined,
): CloudflareToolDefinition[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

export function toCloudflareToolChoice(
  toolMode: vscode.LanguageModelChatToolMode,
  tools: readonly vscode.LanguageModelChatTool[] | undefined,
): CloudflareToolChoiceMode | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  return toolMode === vscode.LanguageModelChatToolMode.Required ? "required" : "auto";
}

function normalizeText(value: unknown): string {
  if (typeof value === "string") {
    return value.toLowerCase();
  }

  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return value.toString().toLowerCase();
  }

  if (Array.isArray(value) || typeof value === "object") {
    const json = JSON.stringify(value);
    return json ? json.toLowerCase() : "";
  }

  return "";
}

function hasNegativePropertyValue(value: string): boolean {
  return NEGATIVE_PROPERTY_VALUES.some((candidate) => value.includes(candidate));
}

function getPropertyCapability(
  model: CloudflareModel,
  propertyHints: readonly string[],
): boolean | undefined {
  if (!model.properties || model.properties.length === 0) {
    return undefined;
  }

  for (const property of model.properties) {
    const propertyId = normalizeText(property.property_id);
    const propertyValue = normalizeText(property.value);
    const matchesHint = propertyHints.some(
      (hint) => propertyId.includes(hint) || propertyValue.includes(hint),
    );

    if (!matchesHint) {
      continue;
    }

    if (hasNegativePropertyValue(propertyValue)) {
      return false;
    }

    return true;
  }

  return undefined;
}

function getModelMetadataText(model: CloudflareModel): string {
  const propertiesText =
    model.properties
      ?.map((property) => `${normalizeText(property.property_id)} ${normalizeText(property.value)}`)
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
    .map(normalizeText)
    .join(" ");
}

function hasCapabilityHint(model: CloudflareModel, hints: readonly string[]): boolean {
  const metadata = getModelMetadataText(model);
  return hints.some((hint) => metadata.includes(hint));
}

interface CapabilityResolutionOptions {
  explicitValue?: boolean;
  propertyHints: readonly string[];
  metadataHints: readonly string[];
}

function resolveCapability(model: CloudflareModel, options: CapabilityResolutionOptions): boolean {
  if (options.explicitValue !== undefined) {
    return options.explicitValue;
  }

  return (
    getPropertyCapability(model, options.propertyHints) ??
    hasCapabilityHint(model, options.metadataHints)
  );
}

export function inferCapabilities(model: CloudflareModel): vscode.LanguageModelChatCapabilities {
  return {
    toolCalling: resolveCapability(model, {
      explicitValue: model.detectedCapabilities?.toolCalling,
      propertyHints: TOOL_CALLING_PROPERTY_HINTS,
      metadataHints: TOOL_CALLING_HINTS,
    }),
    imageInput: resolveCapability(model, {
      explicitValue: model.detectedCapabilities?.imageInput,
      propertyHints: IMAGE_INPUT_PROPERTY_HINTS,
      metadataHints: IMAGE_INPUT_HINTS,
    }),
  };
}

function toShortModelName(modelHandle: string): string {
  const segments = modelHandle.split("/").filter((segment) => segment.length > 0);
  const lastSegment = segments[segments.length - 1];
  return lastSegment || modelHandle;
}

export function getModelDisplayName(model: CloudflareModel, modelHandle: string): string {
  const name = model.name?.trim();
  if (name && name.startsWith("@")) {
    return toShortModelName(name);
  }

  if (name) {
    return name;
  }

  return modelHandle.startsWith("@") ? toShortModelName(modelHandle) : modelHandle;
}

export function getModelDetail(
  model: CloudflareModel,
  capabilities: vscode.LanguageModelChatCapabilities,
): string | undefined {
  const labels: Array<{ label: string; enabled: boolean | undefined }> = [
    { label: "Tools", enabled: capabilities.toolCalling === true },
    { label: "Vision", enabled: capabilities.imageInput === true },
    { label: "JSON", enabled: model.detectedCapabilities?.structuredOutput },
    { label: "Reasoning", enabled: model.detectedCapabilities?.reasoning },
    { label: "Audio input", enabled: model.detectedCapabilities?.audioInput },
    { label: "Audio output", enabled: model.detectedCapabilities?.audioOutput },
  ];
  const detail = labels.filter((item) => item.enabled).map((item) => item.label);

  return detail.length > 0 ? detail.join(" • ") : undefined;
}

function toProviderModelInformation(model: CloudflareModel): ProviderModelInformation {
  const modelHandle = getCloudflareModelHandle(model);
  const capabilities = inferCapabilities(model);

  return {
    id: modelHandle,
    name: getModelDisplayName(model, modelHandle),
    family: modelHandle,
    version: "1.0",
    maxInputTokens: 8192,
    maxOutputTokens: 4096,
    capabilities,
    isUserSelectable: true,
    category: {
      label: "Cloudflare",
      order: 10,
    },
    tooltip: model.description,
    detail: getModelDetail(model, capabilities),
  };
}

class CloudflareModelProvider
  implements vscode.LanguageModelChatProvider<ProviderModelInformation>, RegisteredModelProvider
{
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  private readonly registration = vscode.lm.registerLanguageModelChatProvider("cloudflare", this);
  private modelInfos: ProviderModelInformation[] = [];
  private modelsById = new Map<string, CloudflareModel>();
  private state: CloudflareRequestState | undefined;

  readonly onDidChangeLanguageModelChatInformation = this.onDidChangeEmitter.event;

  updateModels(
    models: CloudflareModel[],
    accountId: string,
    apiKey: string,
    gatewayId?: string,
  ): void {
    this.modelInfos = models.map(toProviderModelInformation);
    this.modelsById = new Map(
      models.map((model) => [getCloudflareModelHandle(model), model] as const),
    );
    this.state = { accountId, apiKey, gatewayId };
    this.onDidChangeEmitter.fire();
  }

  getRegisteredModels(): readonly ProviderModelInformation[] {
    return this.modelInfos;
  }

  provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken,
  ): ProviderModelInformation[] {
    return this.modelInfos;
  }

  async provideTokenCount(
    _model: ProviderModelInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken,
  ): Promise<number> {
    const sourceText = typeof text === "string" ? text : getMessageText(text);
    return Math.ceil(sourceText.length / 4);
  }

  async provideLanguageModelChatResponse(
    model: ProviderModelInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    if (token.isCancellationRequested) {
      return;
    }

    if (!this.state) {
      throw new Error("Cloudflare provider is not configured.");
    }

    const cloudflareModel = this.modelsById.get(model.id);
    if (!cloudflareModel) {
      throw new Error(`Cloudflare model is not registered: ${model.id}`);
    }

    const response = await requestCloudflareChatResponse({
      modelHandle: getCloudflareModelHandle(cloudflareModel),
      state: this.state,
      messages: toCloudflareMessages(messages),
      tools: toCloudflareTools(options.tools),
      toolChoice: toCloudflareToolChoice(options.toolMode, options.tools),
      token,
      errorLabel: "model",
    });

    if (token.isCancellationRequested) {
      return;
    }

    if (!response) {
      return;
    }

    if (response.text) {
      progress.report(new vscode.LanguageModelTextPart(response.text));
    }

    for (const toolCall of response.toolCalls ?? []) {
      progress.report(
        new vscode.LanguageModelToolCallPart(toolCall.callId, toolCall.name, toolCall.input),
      );
    }
  }

  dispose(): void {
    this.registration.dispose();
    this.onDidChangeEmitter.dispose();
  }
}

export function registerModelProvider(): RegisteredModelProvider {
  return new CloudflareModelProvider();
}
