import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
type Request = (path: string, init?: RequestInit) => Promise<Record<string, unknown>>;
function option(args: string[], name: string) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
}
async function textFile(file: string, max: number) {
  const path = resolve(file);
  if ((await stat(path)).size > max) throw new Error(`${file} exceeds the ${max}-byte metadata limit.`);
  return readFile(path, 'utf8');
}
export async function modInputFromArgs(args: string[], creating: boolean) {
  let result: Record<string, unknown> = {};
  const metadata = option(args, '--metadata');
  if (metadata) {
    const input: unknown = JSON.parse(await textFile(metadata, 300000));
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('--metadata must contain a JSON object.');
    result = { ...input };
  }
  for (const [flag, key] of [
    ['--title', 'title'], ['--base-game', 'baseGame'], ['--summary', 'description'],
    ['--compatibility', 'compatibility'], ['--repository', 'repositoryUrl'], ['--project', 'projectUrl'],
    ['--download', 'downloadUrl'], ['--cover-url', 'coverUrl'], ['--visibility', 'visibility'],
  ]) { const value = option(args, flag!); if (value !== undefined) result[key!] = value; }
  const slug = option(args, '--mod');
  if (creating && slug !== undefined) result.slug = slug;
  const tags = option(args, '--tags');
  if (tags !== undefined) result.tags = tags.split(',').map(tag => tag.trim()).filter(Boolean);
  for (const [flag, key, limit] of [['--description-file', 'descriptionMarkdown', 160000], ['--install-file', 'installationMarkdown', 80000]] as const) {
    const file = option(args, flag); if (file) result[key] = await textFile(file, limit);
  }
  if (args.includes('--rights-confirmed')) result.rightsConfirmed = true;
  if (creating) {
    for (const key of ['slug', 'title', 'baseGame']) if (typeof result[key] !== 'string' || !String(result[key]).trim()) throw new Error('Create requires --mod, --title and --base-game (or those fields in --metadata).');
    result.visibility ??= 'draft';
  }
  return result;
}
export async function modsCommand(args: string[], request: Request) {
  const action = args[0]; const options = args.slice(1);
  const json = (body: unknown, method: string): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (action === 'list' || action === 'browse') {
    const offset = option(options, '--offset') || '0';
    if (!/^\d{1,6}$/.test(offset)) throw new Error('--offset must be 0–999999.');
    const query = new URLSearchParams({ offset });
    if (action === 'browse') {
      const search = option(options, '--query'); const baseGame = option(options, '--base-game');
      if (search) query.set('q', search); if (baseGame) query.set('baseGame', baseGame);
    }
    return request(`${action === 'browse' ? '/api/v1/catalog/mods' : '/api/v1/mods'}?${query}`);
  }
  if (action === 'create') return request('/api/v1/mods', json(await modInputFromArgs(options, true), 'POST'));
  if (!['show', 'update', 'publish', 'unpublish', 'delete'].includes(action || ''))
    throw new Error('Use inkwell mods list|browse|show|create|update|publish|unpublish|delete.');
  const slug = option(options, '--mod');
  if (!slug || slug.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error('Choose a mod with --mod <slug>.');
  const path = `/api/v1/mods/${encodeURIComponent(slug)}`;
  if (action === 'show') return request(path);
  if (action === 'delete') {
    if (!options.includes('--yes')) throw new Error('Pass --yes to remove the listing. External project files are not deleted.');
    return request(path, { method: 'DELETE' });
  }
  const changes = action === 'update' ? await modInputFromArgs(options, false) : { visibility: action === 'publish' ? 'public' : 'draft', ...(options.includes('--rights-confirmed') ? { rightsConfirmed: true } : {}) };
  if (action === 'publish' && !options.includes('--rights-confirmed')) throw new Error('Publishing requires --rights-confirmed: confirm you may distribute the linked mod and media, without unauthorized base-game files.');
  if (action === 'update' && !Object.keys(changes).length) throw new Error('Provide metadata to update.');
  const rawRevision = option(options, '--revision');
  const revision = rawRevision === undefined ? (changes as Record<string, unknown>).revision : Number(rawRevision);
  const current = revision === undefined ? await request(path) : null;
  const resolvedRevision = revision ?? (current?.mod as { revision?: number } | undefined)?.revision;
  if (!Number.isInteger(resolvedRevision) || Number(resolvedRevision) < 1 || Number(resolvedRevision) > 2147483646) throw new Error('A valid mod revision is required.');
  return request(path, json({ ...changes, revision: resolvedRevision }, 'PATCH'));
}
