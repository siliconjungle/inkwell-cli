#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const DEFAULT_API_URL = 'https://inkwell.ing';
const MAX_BUILD_BYTES = 100 * 1024 * 1024;
const MAX_BUILD_FILES = 2_000;
const MAX_BUILD_FILE_BYTES = 20 * 1024 * 1024;
const MAX_BATCH_BYTES = 20 * 1024 * 1024;
const MAX_BATCH_FILES = 20;
const IGNORED_DIRECTORIES = new Set(['.git', '.next', '.vinext', 'node_modules']);

type Config = {
  token?: string;
  apiUrl?: string;
};

type BuildFile = {
  absolutePath: string;
  archivePath: string;
  size: number;
};

type ManifestEntry = { path: string; size: number; sha256: string; contentType: string };

function configPath() {
  const root = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(root, 'inkwell', 'config.json');
}

async function readConfig(): Promise<Config> {
  try {
    return JSON.parse(await readFile(configPath(), 'utf8')) as Config;
  } catch {
    return {};
  }
}

async function writeConfig(config: Config) {
  const path = configPath();
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function valueAfter(args: string[], flag: string) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function firstPositional(args: string[]) {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index]?.startsWith('-')) {
      index += 1;
      continue;
    }
    return args[index];
  }
  return undefined;
}

async function collectBuildFiles(root: string, current = root): Promise<BuildFile[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: BuildFile[] = [];

  for (const entry of entries) {
    if (entry.name === '.DS_Store') continue;
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;

    const absolutePath = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectBuildFiles(root, absolutePath)));
      continue;
    }
    if (!entry.isFile()) continue;

    const info = await stat(absolutePath);
    files.push({
      absolutePath,
      archivePath: relative(root, absolutePath).split(sep).join('/'),
      size: info.size,
    });
  }

  return files;
}

function contentType(path: string) {
  const extension = path.split('.').pop()?.toLowerCase();
  return ({
    html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
    json: 'application/json; charset=utf-8', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
    svg: 'image/svg+xml', wasm: 'application/wasm', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', mp4: 'video/mp4', woff: 'font/woff', woff2: 'font/woff2',
  } as Record<string, string>)[extension || ''] || 'application/octet-stream';
}

async function packageBuild(directory: string) {
  const root = resolve(directory);
  const info = await stat(root).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`Build directory not found: ${directory}`);

  const files = await collectBuildFiles(root);
  if (!files.some((file) => file.archivePath === 'index.html')) {
    throw new Error('The build root must contain index.html.');
  }

  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  if (totalBytes > MAX_BUILD_BYTES) {
    throw new Error('The uncompressed build is over the 100 MB MVP limit.');
  }
  if (files.length > MAX_BUILD_FILES) throw new Error(`The build has more than ${MAX_BUILD_FILES} files.`);
  if (files.some((file) => file.size > MAX_BUILD_FILE_BYTES)) throw new Error('A build file is over the 20 MB per-file limit.');

  const manifest: ManifestEntry[] = [];
  for (const file of files) {
    const bytes = await readFile(file.absolutePath);
    manifest.push({ path: file.archivePath, size: file.size, sha256: createHash('sha256').update(bytes).digest('hex'), contentType: contentType(file.archivePath) });
  }
  return { files, manifest, totalBytes };
}

async function apiRequest(
  path: string,
  init: RequestInit = {},
  credentials: { token?: string; apiUrl?: string } = {},
) {
  const config = await readConfig();
  const token = credentials.token || process.env.INKWELL_TOKEN || config.token;
  if (!token) {
    throw new Error('Not signed in. Run `inkwell login` or set INKWELL_TOKEN.');
  }

  const apiUrl =
    credentials.apiUrl ||
    process.env.INKWELL_API_URL ||
    config.apiUrl ||
    DEFAULT_API_URL;
  const response = await fetch(new URL(path, apiUrl), {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...init.headers,
    },
  });

  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message = typeof body.error === 'string' ? body.error : typeof body.message === 'string' ? body.message : `Request failed (${response.status})`;
    const retryAfter = response.headers.get('retry-after');
    throw new Error(
      response.status === 429 && retryAfter
        ? `${message} Retry after ${retryAfter} seconds.`
        : message,
    );
  }
  return body;
}

async function login(args: string[]) {
  let token = firstPositional(args) || process.env.INKWELL_TOKEN;
  if (!token) {
    console.log('Create an API key at https://inkwell.ing/developer/keys');
    const prompt = createInterface({ input, output });
    token = (await prompt.question('Paste token: ')).trim();
    prompt.close();
  }
  if (!token) throw new Error('A deploy token is required.');

  const current = await readConfig();
  const apiUrl = process.env.INKWELL_API_URL || current.apiUrl || DEFAULT_API_URL;
  const profile = await apiRequest('/api/v1/me', {}, { token, apiUrl });
  await writeConfig({ ...current, token });
  const identity =
    typeof profile.username === 'string'
      ? ` as @${profile.username}`
      : typeof profile.email === 'string'
        ? ` as ${profile.email}`
        : '';
  console.log(`Signed in to Inkwell${identity}.`);
}

async function logout() {
  await unlink(configPath()).catch(() => undefined);
  console.log('Signed out.');
}

async function whoami() {
  const profile = await apiRequest('/api/v1/me');
  console.log(typeof profile.email === 'string' ? profile.email : JSON.stringify(profile, null, 2));
}

async function deploy(args: string[]) {
  const directory = firstPositional(args) || '.';
  const game = valueAfter(args, '--game') || valueAfter(args, '-g');
  if (!game) throw new Error('Choose a game with `--game <slug>`.');

  process.stdout.write(`Packaging ${basename(resolve(directory))}... `);
  const build = await packageBuild(directory);
  console.log(`${build.files.length} files, ${(build.totalBytes / 1024 / 1024).toFixed(1)} MB`);

  const created = await apiRequest(`/api/v1/games/${encodeURIComponent(game)}/builds`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ manifest: build.manifest }),
  });
  const buildRecord = created.build as { publicId?: unknown } | undefined;
  if (!buildRecord || typeof buildRecord.publicId !== 'string') throw new Error('Inkwell did not return a build ID.');
  if (!created.alreadyUploaded) {
    const batches: BuildFile[][] = [];
    let batch: BuildFile[] = [];
    let batchBytes = 0;
    for (const file of build.files) {
      if (batch.length && (batch.length >= MAX_BATCH_FILES || batchBytes + file.size > MAX_BATCH_BYTES)) {
        batches.push(batch); batch = []; batchBytes = 0;
      }
      batch.push(file); batchBytes += file.size;
    }
    if (batch.length) batches.push(batch);

    for (let index = 0; index < batches.length; index += 1) {
      process.stdout.write(`Uploading ${index + 1}/${batches.length}...\r`);
      const form = new FormData();
      for (const file of batches[index]!) {
        form.append('path', file.archivePath);
        form.append('file', new Blob([await readFile(file.absolutePath)], { type: contentType(file.archivePath) }), file.archivePath);
      }
      await apiRequest(`/api/v1/builds/${buildRecord.publicId}/files`, { method: 'POST', body: form });
    }
    output.write('\n');
  }
  const result = created.alreadyUploaded ? created : await apiRequest(`/api/v1/builds/${buildRecord.publicId}/finalize`, { method: 'POST' });

  console.log('Deployment complete.');
  if (typeof result.pageUrl === 'string') console.log(result.pageUrl);
}

function help() {
  console.log(`Inkwell CLI

Usage:
  inkwell login [token]
  inkwell logout
  inkwell whoami
  inkwell deploy [directory] --game <slug>

Environment:
  INKWELL_TOKEN     Override the saved deploy token
  INKWELL_API_URL   Override https://inkwell.ing`);
}

async function main() {
  const command = process.argv[2];
  const args = process.argv.slice(3);

  switch (command) {
    case 'login':
      await login(args);
      break;
    case 'logout':
      await logout();
      break;
    case 'whoami':
      await whoami();
      break;
    case 'deploy':
      await deploy(args);
      break;
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      help();
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
});
