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

## Deploy a game

Your build directory must contain `index.html` at its root. Inkwell ignores development output such as `.git`, `.next`, and `node_modules` and rejects uncompressed builds over 100 MB.

```bash
inkwell deploy ./dist --game my-game
```

This creates a per-file SHA-256 manifest, uploads bounded batches, and publishes the immutable build to its isolated Inkwell origin.

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
