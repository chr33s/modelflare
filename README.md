# Cloudflare Models for Copilot

Automatically fetches and surfaces **Cloudflare Workers AI** models plus provider-prefixed **Cloudflare AI Gateway compat** models in the VS Code Copilot Chat model picker, and can use the same routing paths for inline code completions.

The extension now ships both desktop and web entrypoints, so it can run in desktop VS Code and in **VS Code for the Web** when the host supports VS Code's Language Model APIs.

## Features

- 🔄 Auto-discovers Cloudflare Workers AI models and AI Gateway-supported provider models such as `openai/gpt-5-mini`, `google-ai-studio/gemini-2.5-flash`, and `anthropic/claude-sonnet-4-5`
- ✍️ Supports explicit manual model registration when you want to pin exact handles outside discovery
- 💾 Caches discovered models in workspace state so reloads can restore them without another model search
- 🔒 Secure API key storage via VS Code Secret Storage
- 🌐 Routes provider-prefixed models through the documented **Cloudflare AI Gateway compat** endpoint and uses your configured gateway ID when provided
- 🔃 Manual refresh via command palette
- 🔎 Inspect which models discovery returned, which models were registered, and which models VS Code actually exposes through the LM API
- 🛠 Detects tool-calling, image-input, structured-output, reasoning, and audio capabilities from Cloudflare model schemas when available
- ✨ Inline code completions powered by discovered Cloudflare text generation models with specific Fill-In-The-Middle (FIM) templates for Qwen and DeepSeek models
- 🛡️ High resilience with exponential backoff on HTTP 429/5xx errors
- 📈 Persistent local telemetry tracking request counts and tokens across workspace reloads
- 🌍 Web-extension packaging for vscode.dev/github.dev style browser sessions

## Setup

1. Install the extension
2. Run **"Cloudflare: Store API Key Securely"** from the Command Palette (`Cmd/Ctrl+Shift+P`)
3. Open VS Code Settings (`cloudflareCopilot`) or add entries in `.vscode/settings.json` and set:
   - `cloudflareCopilot.accountId` — your Cloudflare Account ID
     - `cloudflareCopilot.gatewayId` — _(optional)_ your AI Gateway ID if you want a specific gateway instead of the default compat gateway
     - `cloudflareCopilot.includeGatewaySupportedModels` — include provider-prefixed AI Gateway models in discovery
     - `cloudflareCopilot.gatewaySupportedModelProviders` — _(optional)_ allowlist specific compat providers such as `openai`, `anthropic`, or `google-ai-studio`
     - `cloudflareCopilot.manualModels` — _(optional)_ register exact model handles manually
   - `cloudflareCopilot.completionModel` — _(optional)_ model handle, name, or id to pin for inline completions
4. Models will appear automatically in the **Copilot Chat model picker** and are also used for inline code completions
5. Run **"Cloudflare: Refresh Models"** any time you want to bypass the cached model list and fetch the latest catalog for the current account

Example manual model configuration:

```json
{
  "cloudflareCopilot.manualModels": [
    {
      "model": "openai/gpt-5-mini",
      "name": "GPT-5 Mini",
      "capabilities": {
        "toolCalling": true,
        "structuredOutput": true
      }
    },
    {
      "model": "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
    }
  ]
}
```

## Settings

| Setting                                            | Description                                                       | Default                                                                                                 |
| -------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `cloudflareCopilot.accountId`                      | Cloudflare Account ID                                             | —                                                                                                       |
| `cloudflareCopilot.apiKey`                         | API key. Prefer the command-backed secret storage instead.        | —                                                                                                       |
| `cloudflareCopilot.gatewayId`                      | Optional specific AI Gateway ID for compat routing                | —                                                                                                       |
| `cloudflareCopilot.includeGatewaySupportedModels`  | Include AI Gateway supported-model discovery                      | `true`                                                                                                  |
| `cloudflareCopilot.gatewaySupportedModelProviders` | Optional allowlist for AI Gateway providers                       | `[]`                                                                                                    |
| `cloudflareCopilot.manualModels`                   | Optional explicit model registrations                             | `[]`                                                                                                    |
| `cloudflareCopilot.modelFilter`                    | Which discovered Cloudflare model types to surface                | `Text Generation`                                                                                       |
| `cloudflareCopilot.completionModel`                | Optional inline completion model override                         | `""`                                                                                                    |
| `cloudflareCopilot.completionSystemPrompt`         | Optional system prompt override for inline completions            | `You are a precise code completion engine. Return only the completion with no markdown or explanation.` |
| `cloudflareCopilot.completionExcludedLanguages`    | Language IDs that should not receive inline completions           | `["plaintext", "markdown", "json", "jsonc", "log"]`                                                     |
| `cloudflareCopilot.capabilityOverrides`            | JSON object overriding default model capabilities by model handle | `{}`                                                                                                    |

`.vscode/settings.json`

```jsonc
{
  "cloudflareCopilot.accountId": "your-account-id",
  // Prefer the "Cloudflare: Store Credentials" command instead of plain-text settings.
  "cloudflareCopilot.apiKey": "your-api-key",
  "cloudflareCopilot.gatewayId": "your-gateway-id",
  "cloudflareCopilot.includeGatewaySupportedModels": true,
  "cloudflareCopilot.gatewaySupportedModelProviders": ["openai", "anthropic", "google-ai-studio"],
  "cloudflareCopilot.manualModels": [
    {
      "model": "openai/gpt-5-mini",
      "name": "GPT-5 Mini",
      "description": "Pinned compat model",
      "task": "Text Generation",
      "capabilities": {
        "toolCalling": true,
        "structuredOutput": true,
        "reasoning": true,
      },
    },
    {
      "model": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    },
  ],
  "cloudflareCopilot.modelFilter": "all",
  "cloudflareCopilot.completionModel": "@cf/qwen/qwen2.5-coder-32b-instruct",
  "cloudflareCopilot.completionSystemPrompt": "You are a precise code completion engine. Return only the completion with no markdown or explanation.",
  "cloudflareCopilot.completionExcludedLanguages": [
    "plaintext",
    "markdown",
    "json",
    "jsonc",
    "log",
  ],
  "cloudflareCopilot.capabilityOverrides": {
    "openai/gpt-5-mini": {
      "toolCalling": true,
      "structuredOutput": true,
    },
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast": {
      "reasoning": true,
    },
  },
}
```

## Architecture

```
VS Code Copilot Chat
       ↓
vscode.lm.registerLanguageModelChatProvider (single provider exposing Workers AI + AI Gateway compat models)
       ↓
Cloudflare AI Gateway compat endpoint  (provider-prefixed models, or any model when gatewayId is set)
                      ↓
Upstream provider or Workers AI

Cloudflare Workers AI direct endpoint  (hosted @cf/... models when no gateway compat routing is needed)
```

## Commands

- `Cloudflare: Refresh Models` — bypass the cached model list, re-fetch, and re-register all models
- `Cloudflare: Inspect Models` — compare discovery results, provider registrations, and what VS Code exposes via `selectChatModels`
- `Cloudflare: Store Credentials` — store your API key in VS Code secret storage

## Development

Development tooling requires Node >=22.18.0 because the web build and web test helpers are executed directly as `.mts` files using Node's native TypeScript support.

```sh
npm install
npm run compile

vscode:<CTRL+P> > Developer: Reload Window
                > Cloudflare: Inspect Models
```

Use `npm run build` or `npm run package` to produce a VSIX, `npm run install:local` to install that VSIX into a local desktop VS Code, and `npm run build:insiders` for the full desktop Insiders workflow. The Insiders command packages the extension, installs the generated VSIX into the launcher's isolated `.vscode-insiders/extensions` sandbox, and starts a desktop VS Code runtime with the dev overlay required for `enabledApiProposals: ["languageModelThinkingPart"]`.

For iterative browser-host development, use `npm run watch-web` to rebuild the bundled web worker entrypoint.
Use `npm run test-web` for a browser-host smoke test that validates the extension is discoverable and activatable in VS Code for the Web.
Dedicated thinking/reasoning response parts are treated as optional; if a host does not expose a thinking-part API, the extension still works and simply omits those parts.

That workflow creates a dev-only manifest overlay under `.vscode-insiders/dev-extension`, adds `enabledApiProposals: ["languageModelThinkingPart"]` there, installs the packaged VSIX into the same sandbox for parity and smoke-testing, and then launches the proposed-API session from the dev overlay without changing the published manifest.
It prefers VS Code Insiders, but falls back to a local `code` install when Insiders is unavailable. If your executable lives somewhere else, set `VSCODE_INSIDERS_PATH` before running the command.
