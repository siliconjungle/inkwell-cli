#!/usr/bin/env node

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { access, mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { parse as parseDotenv } from "dotenv";
import { build as esbuild } from "esbuild";

const DEFAULT_API_URL = "https://inkwell.ing";
const MAX_BUILD_BYTES = 1024 * 1024 * 1024;
const MAX_BUILD_FILES = 2_000;
const MAX_BUILD_FILE_BYTES = 32 * 1024 * 1024;
const MAX_MULTIPART_BATCH_BYTES = 24 * 1024 * 1024;
const MAX_BATCH_FILES = 20;
const IGNORED_DIRECTORIES = new Set([".git", ".next", ".vinext", "node_modules"]);
const SENSITIVE_BUILD_FILES = new Set([".dev.vars", ".npmrc"]);
const SECRET_NAME = /^[A-Z_][A-Z0-9_]*$/;
const RESERVED_SECRET_NAMES = new Set(["NODE_OPTIONS", "PORT", "PATH", "HOME", "HOSTNAME", "PWD"]);
const RESERVED_SECRET_PREFIXES = ["INKWELL_", "FLY_", "NODE_", "LD_", "DYLD_"];
const CONFIG_FILES = ["inkwell.config.ts", "inkwell.config.mjs", "inkwell.config.js"];
const MAX_BACKEND_BUNDLE_BYTES = 10 * 1024 * 1024;
const MAX_SECRET_VALUE_BYTES = 64 * 1024;
const MAX_SECRETS_PAYLOAD_BYTES = 256 * 1024;

type Config = {
  token?: string;
  apiUrl?: string;
};

type GithubActionsCredentials = {
  token: string;
  apiUrl: string;
  deploymentId: string;
  target: "production" | "preview";
};

type BuildFile = {
  absolutePath: string;
  archivePath: string;
  size: number;
};

type ManifestEntry = { path: string; size: number; sha256: string; contentType: string };

type GameConfig = {
  client: { directory: string };
  backend?: {
    entry: string;
    region?: string;
    maxConnections?: number;
    resources?: { memoryMb?: number; sharedCpus?: number };
  };
};

function configPath() {
  const root = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(root, "inkwell", "config.json");
}

async function readConfig(): Promise<Config> {
  try {
    return JSON.parse(await readFile(configPath(), "utf8")) as Config;
  } catch {
    return {};
  }
}

async function writeConfig(config: Config) {
  const path = configPath();
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function valueAfter(args: string[], flag: string) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function firstPositional(args: string[]) {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index]?.startsWith("-")) {
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
    if (entry.name === ".DS_Store") continue;
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;

    const absolutePath = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectBuildFiles(root, absolutePath)));
      continue;
    }
    if (!entry.isFile()) continue;

    if (
      entry.name === ".env" ||
      entry.name.startsWith(".env.") ||
      SENSITIVE_BUILD_FILES.has(entry.name)
    ) {
      throw new Error(
        `Refusing to package ${relative(root, absolutePath)} because it may contain secrets. ` +
          "Use `inkwell secrets import` to upload server-only environment variables.",
      );
    }

    const info = await stat(absolutePath);
    files.push({
      absolutePath,
      archivePath: relative(root, absolutePath).split(sep).join("/"),
      size: info.size,
    });
  }

  return files;
}

function contentType(path: string) {
  const extension = path.split(".").pop()?.toLowerCase();
  return (
    (
      {
        html: "text/html; charset=utf-8",
        js: "text/javascript; charset=utf-8",
        mjs: "text/javascript; charset=utf-8",
        css: "text/css; charset=utf-8",
        json: "application/json; charset=utf-8",
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        webp: "image/webp",
        gif: "image/gif",
        svg: "image/svg+xml",
        wasm: "application/wasm",
        mp3: "audio/mpeg",
        ogg: "audio/ogg",
        wav: "audio/wav",
        mp4: "video/mp4",
        woff: "font/woff",
        woff2: "font/woff2",
      } as Record<string, string>
    )[extension || ""] || "application/octet-stream"
  );
}

export async function packageBuild(directory: string) {
  const root = resolve(directory);
  const info = await stat(root).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`Build directory not found: ${directory}`);

  const files = await collectBuildFiles(root);
  if (!files.some((file) => file.archivePath === "index.html")) {
    throw new Error("The build root must contain index.html.");
  }

  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  if (totalBytes > MAX_BUILD_BYTES) {
    throw new Error("The uncompressed build is over the 1 GiB limit.");
  }
  if (files.length > MAX_BUILD_FILES)
    throw new Error(`The build has more than ${MAX_BUILD_FILES} files.`);
  if (files.some((file) => file.size > MAX_BUILD_FILE_BYTES))
    throw new Error("A build file is over the 32 MiB per-file limit.");

  const manifest: ManifestEntry[] = [];
  for (const file of files) {
    const bytes = await readFile(file.absolutePath);
    manifest.push({
      path: file.archivePath,
      size: file.size,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      contentType: contentType(file.archivePath),
    });
  }
  return { files, manifest, totalBytes };
}

export function createUploadBatches(files: BuildFile[]) {
  const batches: BuildFile[][] = [];
  let batch: BuildFile[] = [];
  let batchBytes = 0;
  for (const file of files) {
    if (
      batch.length &&
      (batch.length >= MAX_BATCH_FILES ||
        batchBytes + file.size > MAX_MULTIPART_BATCH_BYTES)
    ) {
      batches.push(batch);
      batch = [];
      batchBytes = 0;
    }
    batch.push(file);
    batchBytes += file.size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export function createUploadPlan(files: BuildFile[]) {
  const directFiles = files.filter(
    (file) => file.size > MAX_MULTIPART_BATCH_BYTES,
  );
  const batches = createUploadBatches(
    files.filter((file) => file.size <= MAX_MULTIPART_BATCH_BYTES),
  );
  return { batches, directFiles };
}

export function multipartUploadRequest(form: FormData): RequestInit {
  // POST multipart bodies are intercepted by progressive Server Actions before
  // API routing in vinext. PUT reaches the authenticated build upload handler.
  return { method: "PUT", body: form };
}

async function findConfig(root = process.cwd()) {
  for (const name of CONFIG_FILES) {
    const path = join(root, name);
    if (await access(path).then(() => true).catch(() => false)) return path;
  }
  return null;
}

function safeConfigPath(value: unknown, label: string) {
  if (
    typeof value !== "string" ||
    !value ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.split(/[\\/]/).some((part) => part === "..")
  ) {
    throw new Error(`${label} must be a safe relative path.`);
  }
  return value;
}

function validateGameConfig(value: unknown): GameConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Inkwell config must export an object.");
  }
  const config = value as Record<string, unknown>;
  const client = config.client as Record<string, unknown> | undefined;
  if (!client || typeof client !== "object" || Array.isArray(client)) {
    throw new Error("Inkwell config requires client.directory.");
  }
  const result: GameConfig = {
    client: { directory: safeConfigPath(client.directory, "client.directory") },
  };
  if (config.backend === undefined) return result;
  if (!config.backend || typeof config.backend !== "object" || Array.isArray(config.backend)) {
    throw new Error("backend must be an object.");
  }
  const backend = config.backend as Record<string, unknown>;
  const resources = backend.resources as Record<string, unknown> | undefined;
  const maxConnections = backend.maxConnections ?? 100;
  if (
    !Number.isInteger(maxConnections) ||
    (maxConnections as number) < 1 ||
    (maxConnections as number) > 10_000
  ) {
    throw new Error("backend.maxConnections must be an integer from 1 to 10,000.");
  }
  const memoryMb = resources?.memoryMb ?? 256;
  const sharedCpus = resources?.sharedCpus ?? 1;
  if (![256, 512, 1024, 2048].includes(memoryMb as number)) {
    throw new Error("backend.resources.memoryMb is unsupported.");
  }
  if (![1, 2, 4].includes(sharedCpus as number)) {
    throw new Error("backend.resources.sharedCpus is unsupported.");
  }
  if (
    backend.region !== undefined &&
    (typeof backend.region !== "string" || !/^[a-z][a-z0-9-]{1,15}$/.test(backend.region))
  ) {
    throw new Error("backend.region is invalid.");
  }
  result.backend = {
    entry: safeConfigPath(backend.entry, "backend.entry"),
    maxConnections: maxConnections as number,
    ...(typeof backend.region === "string" ? { region: backend.region } : {}),
    resources: { memoryMb: memoryMb as number, sharedCpus: sharedCpus as number },
  };
  return result;
}

export async function loadGameConfig(root = process.cwd()) {
  const path = await findConfig(root);
  if (!path) return null;
  const result = await esbuild({
    entryPoints: [path],
    absWorkingDir: root,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    write: false,
    logLevel: "silent",
  });
  const source = result.outputFiles[0]?.text;
  if (!source) throw new Error("Could not compile the Inkwell config.");
  const module = (await import(
    `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
  )) as { default?: unknown };
  return { path, root, config: validateGameConfig(module.default) };
}

export async function bundleBackend(root: string, entry: string) {
  const entryPath = resolve(root, safeConfigPath(entry, "backend.entry"));
  const result = await esbuild({
    entryPoints: [entryPath],
    absWorkingDir: root,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    write: false,
    legalComments: "none",
    sourcemap: false,
    logLevel: "silent",
    banner: { js: "// Bundled by Inkwell. Server-only code; never served to game clients." },
  });
  const bytes = result.outputFiles[0]?.contents;
  if (!bytes?.byteLength) throw new Error("Backend bundle is empty.");
  if (bytes.byteLength > MAX_BACKEND_BUNDLE_BYTES) {
    throw new Error("Backend bundle is over the 10 MiB limit.");
  }
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function apiRequest(
  path: string,
  init: RequestInit = {},
  credentials: { token?: string; apiUrl?: string } = {},
) {
  const config = await readConfig();
  const token = credentials.token || process.env.INKWELL_TOKEN || config.token;
  if (!token) {
    throw new Error("Not signed in. Run `inkwell login` or set INKWELL_TOKEN.");
  }

  const apiUrl =
    credentials.apiUrl || process.env.INKWELL_API_URL || config.apiUrl || DEFAULT_API_URL;
  const response = await fetch(new URL(path, apiUrl), {
    ...init,
    headers: (() => {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${token}`);
      return headers;
    })(),
  });

  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message =
      typeof body.error === "string"
        ? body.error
        : typeof body.message === "string"
          ? body.message
          : `Request failed (${response.status})`;
    const retryAfter = response.headers.get("retry-after");
    throw new Error(
      response.status === 429 && retryAfter
        ? `${message} Retry after ${retryAfter} seconds.`
        : message,
    );
  }
  return body;
}

export async function requestGithubActionsCredentials(
  game: string,
  options: {
    requestUrl?: string;
    requestToken?: string;
    apiUrl?: string;
    fetcher?: typeof fetch;
  } = {},
): Promise<GithubActionsCredentials | null> {
  const requestUrl =
    options.requestUrl ?? process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken =
    options.requestToken ?? process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) return null;
  const fetcher = options.fetcher || fetch;
  const apiUrl = options.apiUrl || process.env.INKWELL_API_URL || DEFAULT_API_URL;
  const oidcUrl = new URL(requestUrl);
  oidcUrl.searchParams.set("audience", "inkwell-deploy");
  const oidcResponse = await fetcher(oidcUrl, {
    headers: { authorization: `Bearer ${requestToken}` },
  });
  const oidcBody = (await oidcResponse.json().catch(() => ({}))) as {
    value?: unknown;
    message?: unknown;
  };
  if (!oidcResponse.ok || typeof oidcBody.value !== "string") {
    throw new Error(
      typeof oidcBody.message === "string"
        ? `GitHub OIDC failed: ${oidcBody.message}`
        : "GitHub did not issue an Actions identity token.",
    );
  }
  const exchangeResponse = await fetcher(new URL("/api/v1/github/actions/exchange", apiUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ game, token: oidcBody.value }),
  });
  const exchange = (await exchangeResponse.json().catch(() => ({}))) as {
    token?: unknown;
    error?: unknown;
    deployment?: { id?: unknown; target?: unknown };
  };
  if (
    !exchangeResponse.ok ||
    typeof exchange.token !== "string" ||
    typeof exchange.deployment?.id !== "string" ||
    (exchange.deployment.target !== "production" && exchange.deployment.target !== "preview")
  ) {
    throw new Error(
      typeof exchange.error === "string"
        ? exchange.error
        : "Inkwell rejected the GitHub Actions identity.",
    );
  }
  return {
    token: exchange.token,
    apiUrl,
    deploymentId: exchange.deployment.id,
    target: exchange.deployment.target,
  };
}

async function finishGithubActionsDeployment(
  credentials: GithubActionsCredentials,
  status: "succeeded" | "failed" | "cancelled",
  error?: string,
) {
  await apiRequest(
    `/api/v1/github/actions/deployments/${encodeURIComponent(credentials.deploymentId)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status, ...(error ? { error: error.slice(0, 1_000) } : {}) }),
    },
    credentials,
  );
}

async function login(args: string[]) {
  let token = firstPositional(args) || process.env.INKWELL_TOKEN;
  if (!token) {
    console.log("Create an API key at https://inkwell.ing/developer/keys");
    const prompt = createInterface({ input, output });
    token = (await prompt.question("Paste token: ")).trim();
    prompt.close();
  }
  if (!token) throw new Error("A deploy token is required.");

  const current = await readConfig();
  const apiUrl = process.env.INKWELL_API_URL || current.apiUrl || DEFAULT_API_URL;
  const profile = await apiRequest("/api/v1/me", {}, { token, apiUrl });
  await writeConfig({ ...current, token });
  const identity =
    typeof profile.username === "string"
      ? ` as @${profile.username}`
      : typeof profile.email === "string"
        ? ` as ${profile.email}`
        : "";
  console.log(`Signed in to Inkwell${identity}.`);
}

async function logout() {
  await unlink(configPath()).catch(() => undefined);
  console.log("Signed out.");
}

async function whoami() {
  const profile = await apiRequest("/api/v1/me");
  console.log(typeof profile.email === "string" ? profile.email : JSON.stringify(profile, null, 2));
}

function requireGame(args: string[]) {
  const game = valueAfter(args, "--game") || valueAfter(args, "-g");
  if (!game) throw new Error("Choose a game with `--game <slug>`.");
  return game;
}

export function validateSecretName(name: string) {
  if (
    !SECRET_NAME.test(name) ||
    name.length > 128 ||
    RESERVED_SECRET_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
    RESERVED_SECRET_NAMES.has(name)
  ) {
    throw new Error(
      `${name || "Secret name"} is not allowed. Use uppercase environment-variable syntax and avoid reserved runtime names.`,
    );
  }
  return name;
}

async function readAllStdin() {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > MAX_SECRET_VALUE_BYTES) {
      throw new Error("Secret value is over the 64 KiB limit.");
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks)
    .toString("utf8")
    .replace(/\r?\n$/, "");
}

async function promptSecretValue() {
  if (!input.isTTY) return readAllStdin();

  return new Promise<string>((resolveValue, reject) => {
    const chunks: string[] = [];
    const wasRaw = input.isRaw;
    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode(wasRaw);
      input.pause();
      output.write("\n");
    };
    const onData = (data: Buffer | string) => {
      const text = data.toString();
      for (const character of text) {
        if (character === "\u0003") {
          cleanup();
          reject(new Error("Cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          resolveValue(chunks.join(""));
          return;
        }
        if (character === "\u007f" || character === "\b") {
          chunks.pop();
          continue;
        }
        chunks.push(character);
      }
    };
    output.write("Secret value (hidden): ");
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

export function validateSecretValues(values: Record<string, string>) {
  const entries = Object.entries(values);
  if (!entries.length) throw new Error("No secrets were found.");
  if (entries.length > 50) throw new Error("At most 50 secrets can be imported at once.");
  for (const [name, value] of entries) {
    validateSecretName(name);
    if (!value.length) throw new Error(`${name} has an empty value.`);
    if (value.includes("\0")) throw new Error(`${name} contains a null byte.`);
    if (Buffer.byteLength(value) > MAX_SECRET_VALUE_BYTES) {
      throw new Error(`${name} is over the 64 KiB per-secret limit.`);
    }
  }
  return values;
}

async function uploadSecrets(game: string, secrets: Record<string, string>) {
  const body = JSON.stringify({ secrets: validateSecretValues(secrets) });
  if (Buffer.byteLength(body) > MAX_SECRETS_PAYLOAD_BYTES) {
    throw new Error("The combined secrets payload is over the 256 KiB limit.");
  }
  const result = await apiRequest(`/api/v1/games/${encodeURIComponent(game)}/backend/secrets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  const stored = Array.isArray(result.secrets)
    ? result.secrets.length
    : Object.keys(secrets).length;
  console.log(`Stored ${stored} server secret${stored === 1 ? "" : "s"} for ${game}.`);
  console.log("Values will be available when the backend next starts or is redeployed.");
}

async function secretsCommand(args: string[]) {
  const action = args[0];
  const actionArgs = args.slice(1);
  const game = requireGame(actionArgs);

  switch (action) {
    case "list": {
      const result = await apiRequest(`/api/v1/games/${encodeURIComponent(game)}/backend/secrets`);
      const secrets = Array.isArray(result.secrets)
        ? (result.secrets as Array<{ name?: unknown; updatedAt?: unknown }>)
        : [];
      if (!secrets.length) {
        console.log("No server secrets are configured.");
        return;
      }
      for (const secret of secrets) {
        if (typeof secret.name === "string") {
          const updated = typeof secret.updatedAt === "string" ? `\t${secret.updatedAt}` : "";
          console.log(`${secret.name}${updated}`);
        }
      }
      return;
    }
    case "set": {
      const name = validateSecretName(actionArgs.find((arg) => !arg.startsWith("-")) || "");
      const value = await promptSecretValue();
      await uploadSecrets(game, { [name]: value });
      return;
    }
    case "import": {
      const path =
        actionArgs.find((arg, index) => {
          if (arg.startsWith("-")) return false;
          return index === 0 || !["--game", "-g"].includes(actionArgs[index - 1] || "");
        }) || ".env";
      const absolutePath = resolve(path);
      const info = await stat(absolutePath);
      if (!info.isFile() || info.size > MAX_SECRETS_PAYLOAD_BYTES) {
        throw new Error("The .env file must be a file no larger than 256 KiB.");
      }
      const values = parseDotenv(await readFile(absolutePath, "utf8"));
      await uploadSecrets(game, values);
      console.log(
        `Imported names from ${relative(process.cwd(), absolutePath) || basename(absolutePath)}; the file stayed local.`,
      );
      return;
    }
    case "unset": {
      const name = validateSecretName(actionArgs.find((arg) => !arg.startsWith("-")) || "");
      await apiRequest(
        `/api/v1/games/${encodeURIComponent(game)}/backend/secrets/${encodeURIComponent(name)}`,
        { method: "DELETE" },
      );
      console.log(`Removed ${name} from ${game}.`);
      return;
    }
    default:
      throw new Error("Use `inkwell secrets list|set|import|unset --game <slug>`.");
  }
}

async function deploy(args: string[]) {
  const project = await loadGameConfig();
  const directory = firstPositional(args) || project?.config.client.directory || ".";
  const game = requireGame(args);

  process.stdout.write(`Packaging ${basename(resolve(directory))}... `);
  const build = await packageBuild(directory);
  console.log(`${build.files.length} files, ${(build.totalBytes / 1024 / 1024).toFixed(1)} MB`);

  const configured = await readConfig();
  const hasDeployToken = Boolean(process.env.INKWELL_TOKEN || configured.token);
  const actionsCredentials = hasDeployToken
    ? null
    : await requestGithubActionsCredentials(game);
  const credentials = actionsCredentials || {};

  try {
    const created = await apiRequest(
      `/api/v1/games/${encodeURIComponent(game)}/builds`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ manifest: build.manifest }),
      },
      credentials,
    );
    const buildRecord = created.build as { publicId?: unknown } | undefined;
    if (!buildRecord || typeof buildRecord.publicId !== "string") {
      throw new Error("Inkwell did not return a build ID.");
    }
    if (!created.alreadyUploaded) {
      const { batches, directFiles } = createUploadPlan(build.files);
      const uploadCount = batches.length + directFiles.length;
      let uploaded = 0;

      for (let index = 0; index < batches.length; index += 1) {
        process.stdout.write(`Uploading ${uploaded + 1}/${uploadCount}...\r`);
        const form = new FormData();
        for (const file of batches[index]!) {
          form.append("path", file.archivePath);
          form.append(
            "file",
            new Blob([await readFile(file.absolutePath)], {
              type: contentType(file.archivePath),
            }),
            file.archivePath,
          );
        }
        await apiRequest(
          `/api/v1/builds/${buildRecord.publicId}/files`,
          multipartUploadRequest(form),
          credentials,
        );
        uploaded += 1;
      }
      for (const file of directFiles) {
        process.stdout.write(`Uploading ${uploaded + 1}/${uploadCount}...\r`);
        await apiRequest(
          `/api/v1/builds/${buildRecord.publicId}/files?path=${encodeURIComponent(file.archivePath)}`,
          {
            method: "PUT",
            headers: { "content-type": contentType(file.archivePath) },
            body: new Blob([await readFile(file.absolutePath)], {
              type: contentType(file.archivePath),
            }),
          },
          credentials,
        );
        uploaded += 1;
      }
      output.write("\n");
    }

    if (project?.config.backend && actionsCredentials?.target !== "preview") {
      process.stdout.write("Bundling server code... ");
      const backend = await bundleBackend(project.root, project.config.backend.entry);
      console.log(`${(backend.bytes.byteLength / 1024).toFixed(1)} KiB`);
      const backendConfig = project.config.backend;
      const deployed = await apiRequest(
        `/api/v1/games/${encodeURIComponent(game)}/backend/deployments`,
        {
          method: "POST",
          headers: {
            "content-type": "text/javascript; charset=utf-8",
            "x-inkwell-content-sha256": backend.sha256,
            "x-inkwell-region": backendConfig.region || "syd",
            "x-inkwell-max-connections": String(backendConfig.maxConnections || 100),
            "x-inkwell-memory-mb": String(backendConfig.resources?.memoryMb || 256),
            "x-inkwell-shared-cpus": String(backendConfig.resources?.sharedCpus || 1),
          },
          body: backend.bytes.slice().buffer as ArrayBuffer,
        },
        credentials,
      );
      console.log(
        deployed.activation === "after-current-server-stops"
          ? "Server deployment uploaded; it will activate after the current server stops."
          : "Server deployment active.",
      );
    }
    if (project?.config.backend && actionsCredentials?.target === "preview") {
      console.log("Preview uses the current production server; server code was not replaced.");
    }

    // Finalization is the publication boundary. Server bundling and upload run
    // first so a failed server build cannot publish a client that depends on it.
    const result = await apiRequest(
      `/api/v1/builds/${buildRecord.publicId}/finalize`,
      { method: "POST" },
      credentials,
    );
    console.log(
      actionsCredentials
        ? `${actionsCredentials.target === "production" ? "Production" : "Preview"} deployment complete.`
        : "Deployment complete.",
    );
    if (typeof result.pageUrl === "string") console.log(result.pageUrl);
    if (actionsCredentials) {
      await finishGithubActionsDeployment(actionsCredentials, "succeeded");
    }
  } catch (error) {
    if (actionsCredentials) {
      await finishGithubActionsDeployment(
        actionsCredentials,
        "failed",
        error instanceof Error ? error.message : String(error),
      ).catch(() => undefined);
    }
    throw error;
  }
}

function help() {
  console.log(`Inkwell CLI

Usage:
  inkwell login [token]
  inkwell logout
  inkwell whoami
  inkwell deploy [directory] --game <slug>
  inkwell secrets list --game <slug>
  inkwell secrets set NAME --game <slug>
  inkwell secrets import [.env] --game <slug>
  inkwell secrets unset NAME --game <slug>

Environment:
  INKWELL_TOKEN     Override the saved deploy token
  INKWELL_API_URL   Override https://inkwell.ing

GitHub Actions automatically uses OIDC when no INKWELL_TOKEN is set.`);
}

async function main() {
  const command = process.argv[2];
  const args = process.argv.slice(3);

  switch (command) {
    case "login":
      await login(args);
      break;
    case "logout":
      await logout();
      break;
    case "whoami":
      await whoami();
      break;
    case "deploy":
      await deploy(args);
      break;
    case "secrets":
      await secretsCommand(args);
      break;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      help();
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

export function isMainModule(moduleUrl: string, executablePath = process.argv[1]) {
  if (!executablePath) return false;
  try {
    // npm and npx launch package binaries through a symlink in node_modules/.bin.
    // Compare canonical filesystem paths so the CLI still starts in that normal case.
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(executablePath);
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  });
}
