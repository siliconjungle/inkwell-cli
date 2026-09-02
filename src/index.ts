#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { zipSync } from 'fflate';

const DEFAULT_API_URL = 'https://inkwell.ing';
const MAX_BUILD_BYTES = 100 * 1024 * 1024;
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

  const entries: Record<string, Uint8Array> = {};
  for (const file of files) entries[file.archivePath] = await readFile(file.absolutePath);

  const archive = zipSync(entries, { level: 6 });
  const digest = createHash('sha256').update(archive).digest('hex');
  return { archive, digest, fileCount: files.length };
}

async function apiRequest(path: string, init: RequestInit = {}) {
  const config = await readConfig();
  const token = process.env.INKWELL_TOKEN || config.token;
  if (!token) {
    throw new Error('Not signed in. Run `inkwell login` or set INKWELL_TOKEN.');
  }

  const apiUrl = process.env.INKWELL_API_URL || config.apiUrl || DEFAULT_API_URL;
  const response = await fetch(new URL(path, apiUrl), {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...init.headers,
    },
  });

  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message = typeof body.message === 'string' ? body.message : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return body;
}

async function login(args: string[]) {
  let token = firstPositional(args) || process.env.INKWELL_TOKEN;
  if (!token) {
    console.log('Create a deploy token at https://inkwell.ing/account/tokens');
    const prompt = createInterface({ input, output });
    token = (await prompt.question('Paste token: ')).trim();
    prompt.close();
  }
  if (!token) throw new Error('A deploy token is required.');

  const current = await readConfig();
  await writeConfig({ ...current, token });
  console.log('Signed in to Inkwell.');
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
  console.log(`${build.fileCount} files`);

  const result = await apiRequest(`/api/v1/games/${encodeURIComponent(game)}/builds`, {
    method: 'POST',
    headers: {
      'content-type': 'application/zip',
      'x-inkwell-content-sha256': build.digest,
    },
    body: Buffer.from(build.archive),
  });

  console.log('Deployment complete.');
  if (typeof result.url === 'string') console.log(result.url);
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
