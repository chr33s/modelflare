# Cloudflare Models for Copilot

Automatically fetches and surfaces all **Cloudflare Workers AI** models in the VS Code Copilot Chat model picker and can use the same routing path for inline code completions.

The extension now ships both desktop and web entrypoints, so it can run in desktop VS Code and in **VS Code for the Web** when the host supports VS Code's Language Model APIs.

## Features

- 🔄 Auto-discovers all available Cloudflare Workers AI text generation models on startup
- 🔒 Secure API key storage via VS Code Secret Storage
- 🌐 Optional routing through **Cloudflare AI Gateway** for analytics, caching & rate limiting
- 🔃 Manual refresh via command palette
- 🔎 Inspect which Cloudflare models VS Code actually exposes through the LM API
- 🛠 Detects tool-calling, image-input, structured-output, reasoning, and audio capabilities from Cloudflare model schemas when available
- ✨ Inline code completions powered by discovered Cloudflare text generation models with specific Fill-In-The-Middle (FIM) templates for Qwen and DeepSeek models
- 🛡️ High resilience with exponential backoff on HTTP 429/5xx errors
- 📈 Persistent local telemetry tracking request counts and tokens across workspace reloads
- 🌍 Web-extension packaging for vscode.dev/github.dev style browser sessions

## Setup

1. Install the extension
2. Run **"Cloudflare: Store API Key Securely"** from the Command Palette (`Cmd/Ctrl+Shift+P`)
3. Open VS Code Settings (`cloudflareCopilot`) and set:
   - `cloudflareCopilot.accountId` — your Cloudflare Account ID
   - `cloudflareCopilot.gatewayId` — _(optional)_ your AI Gateway ID
   - `cloudflareCopilot.completionModel` — _(optional)_ model handle, name, or id to pin for inline completions
4. Models will appear automatically in the **Copilot Chat model picker** and are also used for inline code completions

## Settings

| Setting                                 | Description                                       | Default           |
| --------------------------------------- | ------------------------------------------------- | ----------------- |
| `cloudflareCopilot.accountId`           | Cloudflare Account ID                             | —                 |
| `cloudflareCopilot.apiKey`              | API Key (prefer secret storage)                   | —                 |
| `cloudflareCopilot.gatewayId`           | AI Gateway ID (optional)                          | —                 |
| `cloudflareCopilot.modelFilter`         | `Text Generation` or `all`                        | `Text Generation` |
| `cloudflareCopilot.completionModel`     | Optional inline completion model override         | `""`              |
| `cloudflareCopilot.capabilityOverrides` | JSON object overriding default model capabilities | `{}`              |

## Architecture

```
VS Code Copilot Chat
       ↓
vscode.lm.registerLanguageModelChatProvider (single provider exposing all discovered models)
       ↓
Cloudflare AI Gateway  (if gatewayId set)
       ↓
Cloudflare Workers AI  (model inference)
```

## Commands

- `Cloudflare: Refresh Models` — re-fetch and re-register all models
- `Cloudflare: Inspect Models` — compare fetched Cloudflare models with what VS Code exposes via `selectChatModels`
- `Cloudflare: Store Credentials` — store your API key in VS Code secret storage

## Development

Development tooling requires Node >=22.18.0 because the web build and web test helpers are executed directly as `.mts` files using Node's native TypeScript support.

```sh
npm run install
npm run build

vscode:<CTRL+P> > Developer: Reload Window
                > Cloudflare: Inspect Models
```

Use `npm run build:insiders` for the full desktop Insiders workflow. It packages the extension, installs the generated VSIX into the launcher's isolated `.vscode-insiders/extensions` sandbox, and starts a desktop VS Code runtime with the dev overlay required for `enabledApiProposals: ["languageModelThinkingPart"]`.

For iterative browser-host development, use `npm run watch-web` to rebuild the bundled web worker entrypoint.
Use `npm run test-web` for a browser-host smoke test that validates the extension is discoverable and activatable in VS Code for the Web.
Dedicated thinking/reasoning response parts are treated as optional; if a host does not expose a thinking-part API, the extension still works and simply omits those parts.

That workflow creates a dev-only manifest overlay under `.vscode-insiders/dev-extension`, adds `enabledApiProposals: ["languageModelThinkingPart"]` there, installs the packaged VSIX into the same sandbox for parity and smoke-testing, and then launches the proposed-API session from the dev overlay without changing the published manifest.
It prefers VS Code Insiders, but falls back to a local `code` install when Insiders is unavailable. If your executable lives somewhere else, set `VSCODE_INSIDERS_PATH` before running the command.
