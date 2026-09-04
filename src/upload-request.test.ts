import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchWithUploadRetry } from './upload-request.js';

const url = new URL('https://example.test/api/v1/builds/abc123/files');
void test('transient upload errors replay multipart bytes and retain credentials', async () => {
  const form = new FormData(); form.append('path', 'game.bin'); form.append('file', new Blob(['immutable bytes']), 'game.bin');
  const delays: number[] = []; const statuses = [500, 502, 200]; let calls = 0;
  const response = await fetchWithUploadRetry(url, {method: 'PUT', body: form, headers: {authorization: 'Bearer scoped-test'}}, {
    fetcher: (async (input, init) => {
      const request = new Request(input, init);
      assert.equal(request.headers.get('authorization'), 'Bearer scoped-test');
      const received = await request.formData();
      assert.equal(received.get('path'), 'game.bin');
      assert.equal(await (received.get('file') as File).text(), 'immutable bytes');
      return new Response('', {status: statuses[calls++]});
    }) as typeof fetch,
    sleep: async ms => { delays.push(ms); },
  });
  assert.equal(response.status, 200); assert.equal(calls, 3); assert.deepEqual(delays, [1000, 2000]);
});
void test('chunk network failure retries, but stops after three retries', async () => {
  let calls = 0;
  await assert.rejects(fetchWithUploadRetry(new URL('/api/v1/builds/abc123/chunks?index=0', url), {method: 'PUT', body: new Blob(['part'])}, {
    fetcher: (async () => { calls++; throw new TypeError('network failed'); }) as typeof fetch,
    sleep: async () => {},
  }), /network failed/);
  assert.equal(calls, 4);
});
void test('permanent errors, rate limits, non-upload mutations and consumed streams are not retried', async () => {
  for (const [path, init, status] of [
    [url, {method: 'PUT', body: 'data'}, 400],
    [url, {method: 'PUT', body: 'data'}, 401],
    [url, {method: 'PUT', body: 'data'}, 403],
    [url, {method: 'PUT', body: 'data'}, 409],
    [url, {method: 'PUT', body: 'data'}, 429],
    [url, {method: 'POST', body: 'data'}, 500],
    [new URL('/api/v1/builds/abc123/publish', url), {method: 'POST'}, 500],
    [new URL('/api/v1/games/game/backend/secrets', url), {method: 'PUT', body: 'secret'}, 500],
    [url, {method: 'PUT', body: new ReadableStream()}, 500],
  ] as Array<[URL, RequestInit, number]>) {
    let calls = 0;
    const result = await fetchWithUploadRetry(path, init, {fetcher: (async () => { calls++; return new Response('', {status}); }) as typeof fetch, sleep: async () => {throw new Error('Unexpected retry');}});
    assert.equal(result.status, status); assert.equal(calls, 1);
  }
});
void test('abort during backoff stops before another request', async () => {
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(fetchWithUploadRetry(url, {method: 'PUT', body: 'data', signal: controller.signal}, {
    fetcher: (async () => { calls++; return new Response('', {status: 503}); }) as typeof fetch,
    sleep: async () => { controller.abort(); },
  }), {name: 'AbortError'});
  assert.equal(calls, 1);
});
