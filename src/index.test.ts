import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  bundleBackend,
  loadGameConfig,
  packageBuild,
  requestGithubActionsCredentials,
  validateSecretName,
  validateSecretValues,
} from "./index.js";

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
