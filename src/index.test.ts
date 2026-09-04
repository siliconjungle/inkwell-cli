import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  bundleBackend,
  createUploadBatches,
  createUploadPlan,
  multipartUploadRequest,
  isMainModule,
  loadGameConfig,
  packageBuild,
  requestGithubActionsCredentials,
  validateSecretName,
  validateSecretValues,
} from "./index.js";

const MEBIBYTE = 1024 * 1024;

void test("recognizes npm-style symlinked package binaries as the main module", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inkwell-cli-entrypoint-test-"));
  try {
    const modulePath = join(directory, "dist", "index.js");
    const executablePath = join(directory, "node_modules", ".bin", "inkwell");
    await mkdir(join(directory, "dist"), { recursive: true });
    await mkdir(join(directory, "node_modules", ".bin"), { recursive: true });
    await writeFile(modulePath, "");
    await symlink(modulePath, executablePath);

    assert.equal(isMainModule(pathToFileURL(modulePath).href, executablePath), true);
    assert.equal(
      isMainModule(pathToFileURL(join(directory, "other.js")).href, executablePath),
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("exchanges GitHub Actions OIDC for a short-lived game credential", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.startsWith("https://oidc.actions.example/token")) {
      return Response.json({ value: "signed-github-identity" });
    }
    return Response.json({
      token: "ink_gha_temporary",
      deployment: { id: "deploy123", target: "production" },
    });
  }) as typeof fetch;

  const credentials = await requestGithubActionsCredentials("pathweaver", {
    requestUrl: "https://oidc.actions.example/token?api-version=1",
    requestToken: "runner-request-token",
    apiUrl: "https://inkwell.example",
    fetcher,
  });

  assert.deepEqual(credentials, {
    token: "ink_gha_temporary",
    apiUrl: "https://inkwell.example",
    deploymentId: "deploy123",
    target: "production",
  });
  assert.match(requests[0]!.url, /audience=inkwell-deploy/);
  assert.equal(
    new Headers(requests[0]!.init?.headers).get("authorization"),
    "Bearer runner-request-token",
  );
  assert.equal(requests[1]!.url, "https://inkwell.example/api/v1/github/actions/exchange");
  assert.deepEqual(JSON.parse(String(requests[1]!.init?.body)), {
    game: "pathweaver",
    token: "signed-github-identity",
  });
});

void test("does not attempt OIDC outside GitHub Actions", async () => {
  assert.equal(
    await requestGithubActionsCredentials("pathweaver", {
      requestUrl: "",
      requestToken: "",
    }),
    null,
  );
});

void test("validates server secret names and values before sending them", () => {
  assert.equal(validateSecretName("STRIPE_API_KEY"), "STRIPE_API_KEY");
  assert.deepEqual(validateSecretValues({ TOKEN: "opaque=value" }), {
    TOKEN: "opaque=value",
  });
  for (const name of [
    "INKWELL_GAME_ID",
    "FLY_API_TOKEN",
    "NODE_OPTIONS",
    "NODE_PATH",
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "bad",
  ]) {
    assert.throws(() => validateSecretName(name));
  }
  assert.throws(() => validateSecretValues({ TOKEN: "" }));
  assert.throws(() => validateSecretValues({ TOKEN: "before\0after" }));
});

void test("refuses to package dotenv files anywhere in a browser build", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inkwell-cli-test-"));
  try {
    await writeFile(join(directory, "index.html"), "<h1>game</h1>");
    await mkdir(join(directory, "nested"));
    await writeFile(join(directory, "nested", ".env.production"), "SECRET=value");
    await assert.rejects(packageBuild(directory), /Refusing to package/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("keeps multipart batches within the conservative memory budget", () => {
  const files = [
    { absolutePath: "/a", archivePath: "textures/large.png", size: 20 * MEBIBYTE },
    { absolutePath: "/b", archivePath: "textures/one.png", size: 3_700_000 },
    { absolutePath: "/c", archivePath: "textures/two.png", size: 3_600_000 },
  ];
  const batches = createUploadBatches(files);
  assert.deepEqual(
    batches.map((batch) => batch.map((file) => file.archivePath)),
    [["textures/large.png", "textures/one.png"], ["textures/two.png"]],
  );
  assert.ok(
    batches.every(
      (batch) => batch.reduce((total, file) => total + file.size, 0) <= 24 * MEBIBYTE,
    ),
  );
});

void test("multipart upload uses PUT to bypass progressive Server Action interception", () => {
  const form = new FormData();
  form.append("path", "index.html");
  form.append("file", new Blob(["game"]), "index.html");
  const request = multipartUploadRequest(form);
  assert.equal(request.method, "PUT");
  assert.equal(request.body, form);
});

void test("uses raw uploads for large individual files", () => {
  const large = {
    absolutePath: "/large",
    archivePath: "models/nibs.glb",
    size: 27_197_228,
  };
  const small = {
    absolutePath: "/small",
    archivePath: "textures/one.png",
    size: 3_700_000,
  };
  assert.deepEqual(createUploadPlan([large, small]), {
    batches: [[small]],
    directFiles: [large],
  });
});

void test("rejects a build above 1 GiB before reading sparse asset files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inkwell-large-build-test-"));
  try {
    await writeFile(join(directory, "index.html"), "x");
    for (let index = 0; index < 32; index += 1) {
      const path = join(directory, `chunk-${index}.bin`);
      await writeFile(path, "");
      await truncate(path, 32 * MEBIBYTE);
    }
    await assert.rejects(packageBuild(directory), /over the 1 GiB limit/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("rejects an individual file above 32 MiB", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inkwell-file-limit-test-"));
  try {
    await writeFile(join(directory, "index.html"), "x");
    const path = join(directory, "oversized.bin");
    await writeFile(path, "");
    await truncate(path, 32 * MEBIBYTE + 1);
    await assert.rejects(packageBuild(directory), /32 MiB per-file limit/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("loads a project config and bundles backend dependencies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inkwell-config-test-"));
  try {
    await writeFile(
      join(directory, "inkwell.config.ts"),
      'export default { client: { directory: "dist" }, backend: { entry: "server.ts", maxConnections: 42 } };',
    );
    await writeFile(
      join(directory, "server.ts"),
      'import { value } from "./value.ts"; export default { __inkwellBackend: 1, value };',
    );
    await writeFile(join(directory, "value.ts"), "export const value = 42;");
    const loaded = await loadGameConfig(directory);
    assert.equal(loaded?.config.backend?.maxConnections, 42);
    const bundle = await bundleBackend(directory, "server.ts");
    assert.ok(bundle.bytes.byteLength > 0);
    assert.match(new TextDecoder().decode(bundle.bytes), /value = 42/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
