import assert from 'node:assert/strict';
import test from 'node:test';
import { modsCommand } from './mods.js';
test('mod create sends only JSON listing metadata and defaults to draft', async () => {
  const calls: Array<{path: string; init?: RequestInit}> = [];
  const request = async (path: string, init?: RequestInit) => { calls.push({path,init}); return { mod: { slug:'my-mod', revision: 1 } }; };
  await modsCommand(['create','--mod','my-mod','--title','My Mod','--base-game','Old Game','--repository','https://github.com/me/mod'], request);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.path, '/api/v1/mods');
  assert.equal(calls[0]?.init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { slug:'my-mod',title:'My Mod',baseGame:'Old Game',repositoryUrl:'https://github.com/me/mod',visibility:'draft' });
});
test('publish requires rights and uses the current revision without overwriting metadata', async () => {
  const calls: Array<{path: string; init?: RequestInit}> = [];
  const request = async (path: string, init?: RequestInit) => { calls.push({path,init}); return { mod: { revision: 7 } }; };
  await assert.rejects(modsCommand(['publish','--mod','my-mod'], request), /rights-confirmed/);
  assert.equal(calls.length,0);
  await modsCommand(['publish','--mod','my-mod','--rights-confirmed'], request);
  assert.equal(calls.length,2);
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)),{visibility:'public',rightsConfirmed:true,revision:7});
  await modsCommand(['unpublish','--mod','my-mod','--revision','8'], request);
  assert.deepEqual(JSON.parse(String(calls[2]?.init?.body)),{visibility:'draft',revision:8});
});
test('mod browse encodes filters, deletion is explicit, malformed revisions do not mutate', async () => {
  const calls: string[] = [];
  const request = async (path: string) => { calls.push(path); return {}; };
  await modsCommand(['browse','--base-game','Old Game','--offset','24'],request);
  assert.equal(calls[0],'/api/v1/catalog/mods?offset=24&baseGame=Old+Game');
  await assert.rejects(modsCommand(['delete','--mod','my-mod'], request), /--yes/);
  await assert.rejects(modsCommand(['unpublish','--mod','my-mod','--revision','oops'], request), /revision/);
  assert.equal(calls.length,1);
});
