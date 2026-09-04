# Inkwell CLI

The official command-line client for deploying static browser games to [Inkwell](https://inkwell.ing).

## Install

Requires Node.js 22.13 or newer.

```bash
npm install --global @silicon-jungle/inkwell-cli
```

## Sign in

Create a deploy token in your Inkwell account, then save it locally:

```bash
inkwell login
```

The token is stored in your user configuration directory with owner-only file permissions. CI can use the `INKWELL_TOKEN` environment variable instead.

GitHub Actions does not need a saved Inkwell token when the repository is
connected to the game. Grant the workflow `id-token: write`; the CLI exchanges
GitHub's signed job identity for a short-lived credential scoped to that game
and that single deployment run.

## Deploy a game

Builds may contain up to 1 GiB of files and 2,000 files. The default entrypoint is `index.html`; configure a different HTML entrypoint when needed. Inkwell ignores development directories such as `.git`, `.next`, and `node_modules`. Large files upload in resumable chunks; repeating the same command resumes verified chunks. Files keep their original names. Precompressed gzip/Brotli files retain the correct content type and encoding; Unity `.unityweb` fallback files are left for its loader to decompress.

```bash
inkwell init --game my-game --directory dist --engine web
inkwell deploy
# Test the printed private preview, then select this build for the live URL:
inkwell publish <build-id>
# Or upload and publish in one explicit operation:
inkwell deploy --publish
```

For automatic deployment from a selected branch:

```yaml
name: Deploy to Inkwell
on:
  push:
    branches: [main]
  workflow_dispatch:
permissions:
  contents: read
  id-token: write
jobs:
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0
        with:
          node-version: 22.13.0
          cache: npm
      - run: npm ci
      - run: npm run build
      - run: npx @silicon-jungle/inkwell-cli deploy --game my-game --publish
```

Set `branches` to the production branch selected on the game's Inkwell
dashboard. A failed workflow leaves the currently published build live.

This creates a per-file SHA-256 manifest, uploads bounded batches/chunks, and publishes only after complete verification. Without `--publish`, deployment uploads a draft. Publishing preserves the game’s private, unlisted, or public visibility. `inkwell publish` can select an older retained build to roll back.

A draft uses the current creator backend. Backend code configured in the project is deployed by `deploy --publish`; a browser-only rollback does not roll back database state or backend code. Preview-scoped GitHub credentials cannot publish or replace a backend.

## Project configuration

```js
export default {
  game: "my-game",
  client: {
    directory: "exports/web",
    entrypoint: "index.html",
    engine: { name: "godot", version: "4.7.2" },
    capabilities: { threads: false },
    startup: { mode: "handshake", timeoutMs: 120000 },
  },
};
```

The CLI reads `inkwell.config.ts`, `.mjs`, or `.js` in the project root. Command-line directory and `--game` override the file. Engines are `web`, `godot`, `unity`, or `unreal`; the last requires an existing browser exporter. Inkwell preserves your HTML shell. Engine configs default to a readiness handshake; legacy configs without an engine default to `compatible`. New `init` configs use the handshake. Report startup through `Inkwell.loading.progress(ratio)`, `Inkwell.ready()`, and `Inkwell.loading.fail(message)` using the SDK or engine wrapper. Configure `threads: true` only for builds that need cross-origin isolation.

## Server secrets

Store API keys and other backend-only environment variables without putting them
in a browser build:

```bash
inkwell secrets set OPENAI_API_KEY --game my-game
inkwell secrets import .env.production --game my-game
inkwell secrets list --game my-game
inkwell secrets unset OPENAI_API_KEY --game my-game
```

`set` reads the value from a hidden prompt (or piped stdin), so it does not appear
in shell history. `import` parses the file locally and sends the values over the
authenticated API; it never uploads the `.env` file as a game asset. List output
contains names and update times only. Values are made available only to the game
backend on its next start or deployment.

The deploy command refuses browser builds containing `.env*`, `.dev.vars`, or
`.npmrc` files.

## Development

```bash
npm run check
npm run build
node dist/index.js --help
```

## License

MIT
