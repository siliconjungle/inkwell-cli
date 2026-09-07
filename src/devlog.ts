import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

type Request = (path: string, init?: RequestInit) => Promise<Record<string, unknown>>;
function option(args: string[], name: string) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}
export async function devlogInputFromArgs(args: string[], creating: boolean) {
  const title = option(args, "--title");
  const file = option(args, "--body-file");
  let body = option(args, "--body");
  if (file !== undefined && body !== undefined)
    throw new Error("Use either --body-file or --body, not both.");
  if (file !== undefined) {
    if ((await stat(resolve(file))).size > 160000)
      throw new Error("Devlog Markdown must be at most 40,000 characters.");
    body = await readFile(resolve(file), "utf8");
  }
  const result: {
    title?: string;
    bodyMarkdown?: string;
    status?: "draft" | "published";
    requestId?: string;
  } = {};
  for (const [key, value, limit] of [
    ["title", title, 160],
    ["bodyMarkdown", body, 40000],
  ] as const) {
    if (creating || value !== undefined) {
      if (typeof value !== "string" || !value.trim() || value.length > limit)
        throw new Error(
          `${key} must contain 1–${limit} characters. Use --title and --body-file (or --body).`,
        );
      result[key] = value.trim();
    }
  }
  if (args.includes("--publish")) result.status = "published";
  if (creating) {
    result.status ??= "draft";
    result.requestId = option(args, "--request-id") ?? randomUUID();
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(result.requestId))
      throw new Error("--request-id must be a UUID.");
  } else if (!Object.keys(result).length)
    throw new Error("Provide --title, --body-file, --body or --publish to update.");
  return result;
}
export async function devlogCommand(args: string[], game: string, request: Request) {
  const action = args[0];
  const options = args.slice(1);
  const path = `/api/v1/games/${encodeURIComponent(game)}/devlogs`;
  const json = (body: unknown, method: string): RequestInit => ({
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (action === "list") {
    const offset = option(options, "--offset") ?? "0";
    if (!/^\d{1,6}$/.test(offset))
      throw new Error("--offset must be a nonnegative integer up to 999999.");
    return request(`${path}?offset=${offset}`);
  }
  if (action === "create") {
    const body = await devlogInputFromArgs(options, true);
    try {
      return await request(path, json(body, "POST"));
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : "Could not create devlog."} Creation request ID: ${body.requestId}. Reuse --request-id with the same content when retrying an uncertain result.`,
      );
    }
  }
  if (!["show", "update", "publish", "unpublish", "delete"].includes(action ?? ""))
    throw new Error("Use inkwell devlog list|show|create|update|publish|unpublish|delete.");
  const postId = option(options, "--post");
  if (!postId || !/^[A-Za-z0-9_-]{1,16}$/.test(postId))
    throw new Error("Provide --post <post-id> from devlog list or create.");
  if (action === "delete" && !options.includes("--yes"))
    throw new Error(
      "Deleting a post is permanent. Pass --yes to delete, or use devlog unpublish to keep a draft.",
    );
  const postPath = `${path}/${encodeURIComponent(postId)}`;
  if (action === "show") return request(postPath);
  const rawRevision = option(options, "--revision");
  if (
    rawRevision !== undefined &&
    (!/^\d+$/.test(rawRevision) || Number(rawRevision) < 1 || Number(rawRevision) > 2147483646)
  )
    throw new Error("--revision must be a positive post revision.");
  const current = rawRevision === undefined ? await request(postPath) : null;
  const revision =
    rawRevision === undefined
      ? (current?.post as { revision?: number } | undefined)?.revision
      : Number(rawRevision);
  if (!Number.isSafeInteger(revision) || Number(revision) < 1)
    throw new Error("Could not read the current post revision.");
  if (action === "delete") return request(postPath, json({ revision }, "DELETE"));
  const changes =
    action === "update"
      ? await devlogInputFromArgs(options, false)
      : { status: action === "publish" ? "published" : "draft" };
  return request(postPath, json({ ...changes, revision }, "PATCH"));
}
