# Sitegeist

AI-powered browser extension for web navigation and interaction.

## Development

Prerequisites: clone this repo plus its sibling dependencies into the same parent directory:

```
parent/
  mini-lit/          # https://github.com/badlogic/mini-lit
  pi-mono/           # https://github.com/badlogic/pi-mono
  sitegeist/         # this repo
```

Install dependencies in each repo:

```bash
(cd ../mini-lit && npm install)
(cd ../pi-mono && npm install)
npm install
```

`npm install` sets up the Husky pre-commit hook automatically.

Start all dev watchers (mini-lit, pi-mono, sitegeist extension, marketing site):

```bash
./dev.sh
```

Changes in `../mini-lit` or `../pi-mono` are rebuilt automatically and picked up by the sitegeist watcher.

To run only the extension watcher without dependencies or the marketing site:

```bash
npm run dev
```

### Loading the extension

1. Open `chrome://extensions/` or `edge://extensions/`
2. Enable Developer mode
3. Click Load unpacked
4. Select `sitegeist/dist-chrome/`
5. Enable the "Allow User Scripts" toggle in the extension details

The extension hot-reloads when the dev watcher rebuilds.

### First run

On first launch, Sitegeist prompts you to connect at least one AI provider. You can log in with a subscription (Anthropic, OpenAI Codex, GitHub Copilot, Google Gemini) or enter an API key.

Some subscription logins require the CORS proxy (configurable in Settings > Proxy). The default proxy is `https://proxy.mariozechner.at/proxy`.

## Checks

```bash
./check.sh
```

Runs formatting, linting, and type checking for the extension and the `site/` subproject.

The Husky pre-commit hook runs the same checks before each commit.

## Building

```bash
npm run build
```

The unpacked extension is written to `dist-chrome/`.

## Publishing

```bash
./publish.sh
```

Builds the extension, creates `sitegeist-latest.zip`, generates `version.json`, and uploads both to `sitegeist.ai/uploads/`.

Requires SSH access to `slayer.marioslab.io`.

## License

MIT
