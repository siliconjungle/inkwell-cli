// Mirrored from @silicon-jungle/inkwell-sdk/config; keep validators in sync when releasing.
export const INKWELL_BACKEND_IDLE_GRACE_SECONDS = 300 as const;

export type BackendRegion =
  | 'ams'
  | 'atl'
  | 'bom'
  | 'cdg'
  | 'dfw'
  | 'ewr'
  | 'fra'
  | 'gru'
  | 'iad'
  | 'jnb'
  | 'lax'
  | 'lhr'
  | 'nrt'
  | 'ord'
  | 'sea'
  | 'sin'
  | 'sjc'
  | 'syd'
  | (string & {});

export type InkwellGameConfig = {
  game?: string;
  client: {
    directory: string;
    entrypoint?: string;
    engine?: { name: 'web' | 'godot' | 'unity' | 'unreal'; version?: string };
    capabilities?: { threads?: boolean };
    startup?: { mode: 'handshake' | 'compatible'; timeoutMs?: number };
  };
  backend?: {
    entry: string;
    region?: BackendRegion;
    maxConnections?: number;
    resources?: {
      memoryMb?: 256 | 512 | 1024 | 2048;
      sharedCpus?: 1 | 2 | 4;
    };
  };
};

function relativePath(value: unknown, label: string) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 500 ||
    value.startsWith('/') ||
    value.startsWith('\\') ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.split(/[\\/]/).some((segment) => segment === '..')
  ) {
    throw new TypeError(`${label} must be a safe relative path.`);
  }
  return value;
}

export function validateGameConfig(value: unknown): InkwellGameConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Inkwell config must be an object.');
  }
  const config = value as Record<string, unknown>;
  const client = config.client as Record<string, unknown> | undefined;
  if (!client || typeof client !== 'object' || Array.isArray(client)) {
    throw new TypeError('Inkwell config requires a client section.');
  }
  const result: InkwellGameConfig = {
    client: { directory: relativePath(client.directory, 'client.directory') },
  };
  if (config.game !== undefined) {
    if (typeof config.game !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(config.game) || config.game.length > 100) {
      throw new TypeError('game must be an Inkwell game slug.');
    }
    result.game = config.game;
  }
  if (client.entrypoint !== undefined) {
    const entrypoint = relativePath(client.entrypoint, 'client.entrypoint');
    if (!/\.html?$/i.test(entrypoint) || entrypoint.includes('\\') || /[?#\u0000-\u001f]/.test(entrypoint) || entrypoint.split('/').some(p => !p || p === '.')) {
      throw new TypeError('client.entrypoint must be a relative HTML file path.');
    }
    result.client.entrypoint = entrypoint;
  }
  if (client.engine !== undefined) {
    if (!client.engine || typeof client.engine !== 'object' || Array.isArray(client.engine)) throw new TypeError('client.engine must be an object.');
    const engine = client.engine as Record<string, unknown>;
    if (!['web', 'godot', 'unity', 'unreal'].includes(engine.name as string)) throw new TypeError('Unsupported client.engine.name.');
    if (engine.version !== undefined && (typeof engine.version !== 'string' || !engine.version.trim() || engine.version.length > 100 || /[\u0000-\u001f]/.test(engine.version))) throw new TypeError('client.engine.version must be a nonempty version string.');
    result.client.engine = { name: engine.name as 'web', ...(engine.version === undefined ? {} : { version: engine.version as string }) };
  }
  if (client.capabilities !== undefined) {
    if (!client.capabilities || typeof client.capabilities !== 'object' || Array.isArray(client.capabilities)) throw new TypeError('client.capabilities must be an object.');
    const capabilities = client.capabilities as Record<string, unknown>;
    if (capabilities.threads !== undefined && typeof capabilities.threads !== 'boolean') throw new TypeError('client.capabilities.threads must be boolean.');
    result.client.capabilities = { threads: capabilities.threads === true };
  }
  if (client.startup !== undefined) {
    if (!client.startup || typeof client.startup !== 'object' || Array.isArray(client.startup)) throw new TypeError('client.startup must be an object.');
    const startup = client.startup as Record<string, unknown>;
    if (!['handshake', 'compatible'].includes(startup.mode as string)) throw new TypeError('client.startup.mode must be handshake or compatible.');
    if (startup.timeoutMs !== undefined && (!Number.isInteger(startup.timeoutMs) || Number(startup.timeoutMs) < 5_000 || Number(startup.timeoutMs) > 600_000)) throw new TypeError('client.startup.timeoutMs must be between 5000 and 600000.');
    result.client.startup = { mode: startup.mode as 'handshake', ...(startup.timeoutMs === undefined ? {} : { timeoutMs: Number(startup.timeoutMs) }) };
  }
  if (config.backend === undefined) return result;
  if (
    !config.backend ||
    typeof config.backend !== 'object' ||
    Array.isArray(config.backend)
  ) {
    throw new TypeError('backend must be an object when provided.');
  }
  const backend = config.backend as Record<string, unknown>;
  const maxConnections = backend.maxConnections ?? 100;
  if (
    !Number.isInteger(maxConnections) ||
    (maxConnections as number) < 1 ||
    (maxConnections as number) > 10_000
  ) {
    throw new TypeError('backend.maxConnections must be an integer from 1 to 10,000.');
  }
  if (
    backend.region !== undefined &&
    (typeof backend.region !== 'string' ||
      !/^[a-z][a-z0-9-]{1,15}$/.test(backend.region))
  ) {
    throw new TypeError('backend.region must be a valid region code.');
  }
  let resources: NonNullable<InkwellGameConfig['backend']>['resources'];
  if (backend.resources !== undefined) {
    if (
      !backend.resources ||
      typeof backend.resources !== 'object' ||
      Array.isArray(backend.resources)
    ) {
      throw new TypeError('backend.resources must be an object.');
    }
    const input = backend.resources as Record<string, unknown>;
    const allowedMemory = new Set([256, 512, 1024, 2048]);
    const allowedCpus = new Set([1, 2, 4]);
    if (input.memoryMb !== undefined && !allowedMemory.has(input.memoryMb as number)) {
      throw new TypeError('backend.resources.memoryMb is not supported.');
    }
    if (input.sharedCpus !== undefined && !allowedCpus.has(input.sharedCpus as number)) {
      throw new TypeError('backend.resources.sharedCpus is not supported.');
    }
    resources = {
      ...(input.memoryMb === undefined ? {} : { memoryMb: input.memoryMb as 256 }),
      ...(input.sharedCpus === undefined ? {} : { sharedCpus: input.sharedCpus as 1 }),
    };
  }
  result.backend = {
    entry: relativePath(backend.entry, 'backend.entry'),
    maxConnections: maxConnections as number,
    ...(backend.region === undefined ? {} : { region: backend.region as BackendRegion }),
    ...(resources === undefined ? {} : { resources }),
  };
  return result;
}

export function defineGameConfig<const Config extends InkwellGameConfig>(
  config: Config,
) {
  validateGameConfig(config);
  return config;
}
