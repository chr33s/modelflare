# Cloudflare Models for Copilot

Automatically fetches and surfaces all **Cloudflare Workers AI** models in the VS Code Copilot Chat model picker and can use the same routing path for inline code completions.

## Features

- 🔄 Auto-discovers all available Cloudflare Workers AI text generation models on startup
- 🔒 Secure API key storage via VS Code Secret Storage
- 🌐 Optional routing through **Cloudflare AI Gateway** for analytics, caching & rate limiting
- 🔃 Manual refresh via command palette
- 🔎 Inspect which Cloudflare models VS Code actually exposes through the LM API
- 🛠 Detects tool-calling, image-input, structured-output, reasoning, and audio capabilities from Cloudflare model schemas when available
- ✨ Inline code completions powered by discovered Cloudflare text generation models

## Setup

1. Install the extension
2. Run **"Cloudflare: Store API Key Securely"** from the Command Palette (`Cmd/Ctrl+Shift+P`)
3. Open VS Code Settings (`cloudflareCopilot`) and set:
   - `cloudflareCopilot.accountId` — your Cloudflare Account ID
   - `cloudflareCopilot.gatewayId` — _(optional)_ your AI Gateway ID
4. Models will appear automatically in the **Copilot Chat model picker** and are also used for inline code completions

## Settings

| Setting                         | Description                     | Default           |
| ------------------------------- | ------------------------------- | ----------------- |
| `cloudflareCopilot.accountId`   | Cloudflare Account ID           | —                 |
| `cloudflareCopilot.apiKey`      | API Key (prefer secret storage) | —                 |
| `cloudflareCopilot.gatewayId`   | AI Gateway ID (optional)        | —                 |
| `cloudflareCopilot.modelFilter` | `Text Generation` or `all`      | `Text Generation` |

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
- `Cloudflare: Inspect Registered Chat Models` — compare fetched Cloudflare models with what VS Code exposes via `selectChatModels`
- `Cloudflare: Store API Key Securely` — store your API key in VS Code secret storage

## Development

```sh
npm run install
npm run package

code --install-extension ./cloudflare-copilot-models-0.0.1.vsix

vscode:<CTRL+P> > Developer: Reload Window
                > Cloudflare: Inspect Registered Chat Models
```
