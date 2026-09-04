import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('./index.ts', import.meta.url));
const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const buildId = 'abcdef123456';

function command(root: string, args: string[], apiUrl?: string, entry = cli) {
  return execute(process.execPath, ['--import', loader, entry, ...args], {
    cwd: root,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: join(root, '.test-config'),
      INKWELL_TOKEN: 'local-command-test',
      INKWELL_API_URL: apiUrl || 'http://127.0.0.1:1',
    },
  });
}

test('npm-style symlink invocation runs the CLI and init preserves existing config', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inkwell-command-'));
  try {
    const link = join(root, 'inkwell.ts');
    await symlink(cli, link);
    assert.match((await command(root, ['--help'], undefined, link)).stdout, /inkwell deploy/);
    await command(root, ['init', '--game', 'engine-demo', '--directory', 'web-export', '--engine', 'godot', '--engine-version', '4.7.2', '--entrypoint', 'web/start.html', '--threads'], undefined, link);
    const configPath = join(root, 'inkwell.config.js');
    const first = await readFile(configPath, 'utf8');
    assert.match(first, /"entrypoint": "web\/start.html"/);
    assert.match(first, /"mode": "handshake"/);
    assert.match(first, /"threads": true/);
    await assert.rejects(command(root, ['init', '--game', 'different-game'], undefined, link), /already has an Inkwell config/);
    assert.equal(await readFile(configPath, 'utf8'), first);
  } finally { await rm(root, {recursive:true, force:true}); }
});

test('deploy defaults to a draft, preserves engine metadata, and publishes only explicitly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inkwell-command-deploy-'));
  const requests: Array<{path:string;method:string;body:Record<string,unknown>}> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString('utf8');
    const body = text ? JSON.parse(text) as Record<string,unknown> : {};
    requests.push({path:request.url!,method:request.method!,body});
    assert.equal(request.headers.authorization, 'Bearer local-command-test');
    response.setHeader('content-type','application/json');
    if (request.url?.endsWith('/builds')) response.end(JSON.stringify({build:{publicId:buildId},alreadyUploaded:true}));
    else if (request.url?.endsWith('/finalize') || request.url?.endsWith('/publish')) response.end(JSON.stringify({published:body.publish===true,pageUrl:'http://local-test/game'}));
    else {response.statusCode=404;response.end(JSON.stringify({error:'Unexpected request'}));}
  });
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const apiUrl = `http://127.0.0.1:${address.port}`;
  const client = {directory:'dist',entrypoint:'web/start.html',engine:{name:'godot',version:'4.7.2'},capabilities:{threads:false},startup:{mode:'handshake',timeoutMs:90000}};
  const configPath=join(root,'inkwell.config.js');
  const writeConfig=(backend=false)=>writeFile(configPath,`export default ${JSON.stringify({game:'engine-demo',client,...(backend?{backend:{entry:'missing-server.ts'}}:{})})};\n`);
  try {
    await mkdir(join(root,'dist/web'),{recursive:true});
    await writeFile(join(root,'dist/web/start.html'),'<canvas></canvas>');
    await writeFile(join(root,'dist/web/game.wasm.br'),'test-encoded-bytes');
    await writeConfig(true);
    const draft = await command(root,['deploy'],apiUrl);
    assert.match(draft.stdout,/Draft uploaded/);
    assert.deepEqual(requests.map(request=>request.path),[`/api/v1/games/engine-demo/builds`,`/api/v1/builds/${buildId}/finalize`]);
    assert.deepEqual(requests[0]!.body.client,client);
    const manifest=requests[0]!.body.manifest as Array<Record<string,unknown>>;
    assert(manifest.some(entry=>entry.path==='web/start.html'));
    assert.deepEqual(manifest.find(entry=>entry.path==='web/game.wasm.br')?.contentEncoding,'br');
    assert.equal(requests[1]!.body.publish,false);
    requests.length=0;
    // A server compilation failure must leave the old client live.
    await assert.rejects(command(root,['deploy','--publish'],apiUrl),/missing-server/);
    assert.deepEqual(requests.map(request=>request.path),['/api/v1/games/engine-demo/builds']);
    requests.length=0;
    await writeConfig();
    assert.match((await command(root,['deploy','--publish','--game','other-game'],apiUrl)).stdout,/Build published/);
    assert.equal(requests[0]!.path,'/api/v1/games/other-game/builds');
    assert.equal(requests[1]!.body.publish,true);
    requests.length=0;
    await command(root,['publish',buildId],apiUrl);
    assert.deepEqual(requests.map(request=>({path:request.path,method:request.method})),[{path:`/api/v1/builds/${buildId}/publish`,method:'POST'}]);
  } finally {
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    await rm(root,{recursive:true,force:true});
  }
});
