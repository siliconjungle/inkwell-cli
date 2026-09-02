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

## Development

```bash
npm run check
npm run build
node dist/index.js --help
```

## License

MIT
