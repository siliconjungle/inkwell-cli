# Inkwell CLI

The official command-line client for deploying static browser games to [Inkwell](https://inkwell.ing).

## Install

Requires Node.js 22.13 or newer.

```bash
npm install --global @silicon-jungle/inkwell-cli
```

## Sign in

Start sign-in from the terminal:

```bash
inkwell login
```

The CLI opens Inkwell in your browser, shows a matching one-time code, and waits for you to approve the device. No copied token is required. The resulting credential is stored in your user configuration directory with owner-only file permissions. Run `inkwell whoami` to confirm the account and creator-access state, or `inkwell doctor` to check the complete local setup. CI can use the `INKWELL_TOKEN` environment variable instead.

Operational commands work with `--game <slug>` or the game in `inkwell.config.*`:

```bash
inkwell status
inkwell logs --follow
inkwell logs --level error
```

GitHub Actions does not need a saved Inkwell token when the repository is
connected to the game. Grant the workflow `id-token: write`; the CLI exchanges
GitHub's signed job identity for a short-lived credential scoped to that game
and that single deployment run.

## Agent-friendly documentation

Fetch concise Markdown without page chrome. No sign-in is required, and topic
files keep context use bounded for coding agents.

```bash
inkwell docs
inkwell docs first-game
inkwell docs api --output INKWELL_API.md
```

The same files are available at `https://inkwell.ing/docs.md` and
`https://inkwell.ing/docs/<topic>.md`. The index lists current topics.

## Deploy a game

Builds may contain up to 1 GiB of files and 2,000 files. The default entrypoint is `index.html`; configure a different HTML entrypoint when needed. Inkwell ignores development directories such as `.git`, `.next`, and `node_modules`. Large files upload in resumable chunks; repeating the same command resumes verified chunks. Files keep their original names. Precompressed gzip/Brotli files retain the correct content type and encoding; Unity `.unityweb` fallback files are left for its loader to decompress.

Content-addressed PUT uploads retry network failures and HTTP 500/502/503/504
up to three times with backoff. Each attempt has a two-minute timeout. The same
bytes are retried; build creation, backend deployment and publication mutations
are never automatically repeated for these errors. Permanent errors still stop
deployment without replacing the live build.

### Complete first publication from the CLI

The CLI can create the game page, upload its page images, upload the browser
build, publish it, and change its visibility. No dashboard step is required.

```bash
inkwell login
inkwell games create \
  --game my-game \
  --title "My Game" \
  --summary "A short public summary." \
  --description-file GAME_PAGE.md \
  --tags action,multiplayer \
  --visibility unlisted \
  --cover cover.png \
  --screenshot screenshot-1.png

inkwell init --game my-game --directory dist --engine web
npm run build
inkwell deploy --publish

# Optional: list it publicly after testing the unlisted URL.
inkwell games update --game my-game --visibility public
```

Creation accepts `private` or `unlisted` visibility because a public game must
have a published build. `games update` can later set `private`, `unlisted`, or
`public`. The slug is permanent. Page images must be JPEG, PNG, WebP, or GIF and
at most 5 MB each. Repeat `--screenshot` to add several screenshots.

Useful management commands:

```bash
inkwell games list
inkwell games show --game my-game
inkwell games update --game my-game --title "New title" --summary "New summary"
inkwell games media upload new-cover.png --game my-game --kind cover --alt "Game cover" --focal-x 50 --focal-y 35
inkwell games media upload room.png --game my-game --kind screenshot --alt "A dungeon room"
```

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
