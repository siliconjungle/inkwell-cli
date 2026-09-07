import assert from "node:assert/strict";
import test from "node:test";
import { devlogInputFromArgs, devlogCommand } from "./devlog.js";
void test("devlog CLI bounds author input and defaults to draft", async () => {
  const draft = await devlogInputFromArgs(["--title", " Hello ", "--body", " Body "], true);
  assert.equal(draft.title, "Hello");
  assert.equal(draft.bodyMarkdown, "Body");
  assert.equal(draft.status, "draft");
  assert.match(draft.requestId!, /^[a-f0-9-]{36}$/);
  for (const args of [
    [],
    ["--title"],
    ["--title", "Title", "--body", " "],
    ["--title", "x".repeat(161), "--body", "body"],
    ["--title", "Title", "--body", "x".repeat(40001)],
    ["--title", "Title", "--body", "body", "--body-file", "file.md"],
    ["--title", "Title", "--body", "body", "--request-id", "bad"],
  ])
    await assert.rejects(devlogInputFromArgs(args, true));
  await assert.rejects(devlogInputFromArgs([], false));
});
void test("uncertain CLI creation exposes its stable request ID without retrying mutations", async () => {
  const id = "12345678-1234-1234-1234-123456789abc";
  let calls = 0;
  await assert.rejects(
    devlogCommand(
      ["create", "--title", "Title", "--body", "Body", "--request-id", id],
      "game",
      async () => {
        calls++;
        throw new Error("Network lost");
      },
    ),
    new RegExp(id),
  );
  assert.equal(calls, 1);
});
