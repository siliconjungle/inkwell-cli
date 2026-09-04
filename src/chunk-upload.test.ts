import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {uploadLargeFile} from './chunk-upload.js';
import {assetMetadata, packageBuild} from './index.js';

test('resumes matching chunks, replaces differing chunks, then assembles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inkwell-chunks-'));
  const bytes = Buffer.from('abcdefghij');
  const calls: Array<{path: string; init?: RequestInit}> = [];
  try {
    await writeFile(join(root, 'game.wasm'), bytes);
    await uploadLargeFile('build123456', {absolutePath: join(root, 'game.wasm'), archivePath: 'Build/game.wasm', size: bytes.length}, async (path, init) => {
      calls.push({path, init});
      if (!init) return {chunkBytes: 4, parts: [{index: 0, sha256: createHash('sha256').update(bytes.subarray(0, 4)).digest('hex')}, {index: 1, sha256: 'old'}]};
      if (init.method === 'PUT') {
        const body = Buffer.from(await (init.body as Blob).arrayBuffer());
        assert.equal(new Headers(init.headers).get('x-inkwell-chunk-sha256'), createHash('sha256').update(body).digest('hex'));
      }
      return {};
    });
    assert.deepEqual(calls.map(call => call.init?.method ?? 'GET'), ['GET', 'PUT', 'PUT', 'POST']);
    assert.ok(calls[1]!.path.endsWith('index=1'));
    assert.ok(calls[2]!.path.endsWith('index=2'));
  } finally {await rm(root, {recursive: true, force: true});}
});

test('packages custom HTML with compressed WASM metadata and no implicit decompression', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inkwell-engine-'));
  try {
    await writeFile(join(root, 'game.html'), '<canvas></canvas>');
    await writeFile(join(root, 'game.wasm.br'), 'encoded');
    const build = await packageBuild(root, 'game.html');
    assert.deepEqual(assetMetadata('game.wasm.br'), {contentType: 'application/wasm', contentEncoding: 'br'});
    assert.deepEqual(assetMetadata('game.framework.js.gz'), {contentType: 'text/javascript; charset=utf-8', contentEncoding: 'gzip'});
    assert.deepEqual(assetMetadata('game.data.unityweb'), {contentType: 'application/octet-stream'});
    assert.equal(build.manifest.find(entry => entry.path === 'game.wasm.br')?.contentEncoding, 'br');
  } finally {await rm(root, {recursive: true, force: true});}
});
