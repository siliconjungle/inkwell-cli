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

void test('real CLI retries only the interrupted upload and publishes once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inkwell-command-retry-'));
  let uploads = 0, created = 0, published = 0;
  let permanent = false;
  const html = '<h1>Retry-safe game</h1>';
  const server = createServer(async (request, response) => {
    const bytes: Buffer[] = [];
    for await (const chunk of request) bytes.push(Buffer.from(chunk));
    assert.equal(request.headers.authorization, 'Bearer local-command-test');
    response.setHeader('content-type', 'application/json');
    if (request.url?.endsWith('/builds')) {
      created++;
      response.end(JSON.stringify({build: {publicId: buildId}, alreadyUploaded: false}));
    } else if (request.url?.endsWith('/files')) {
      assert.equal(request.method, 'PUT');
      const form = await new Response(Buffer.concat(bytes), {headers: {'content-type': request.headers['content-type']!}}).formData();
      assert.equal(form.get('path'), 'index.html');
      assert.equal(await (form.get('file') as File).text(), html);
      uploads++;
      response.statusCode = permanent ? 403 : uploads <= 2 ? 500 : 200;
      response.end(JSON.stringify(response.statusCode === 200 ? {uploaded: ['index.html']} : {error: 'Simulated upload failure'}));
    } else if (request.url?.endsWith('/finalize')) {
      published++;
      assert.equal(JSON.parse(Buffer.concat(bytes).toString()).publish, true);
      response.end(JSON.stringify({published: true}));
    } else { response.statusCode = 404; response.end('{}'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  try {
    await mkdir(join(root, 'dist'));
    await writeFile(join(root, 'dist/index.html'), html);
    const result = await command(root, ['deploy', 'dist', '--game', 'retry-game', '--publish'], `http://127.0.0.1:${address.port}`);
    assert.match(result.stdout, /retrying the same data/);
    assert.equal(created, 1); assert.equal(uploads, 3); assert.equal(published, 1);
    permanent = true;
    await assert.rejects(command(root, ['deploy', 'dist', '--game', 'retry-game', '--publish'], `http://127.0.0.1:${address.port}`), /Simulated upload failure/);
    assert.equal(created, 2); assert.equal(uploads, 4); assert.equal(published, 1);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, {recursive: true, force: true});
  }
});

function command(root: string, args: string[], apiUrl?: string, entry = cli, environment: NodeJS.ProcessEnv = {}) {
  return execute(process.execPath, ['--import', loader, entry, ...args], {
    cwd: root,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: join(root, '.test-config'),
      INKWELL_TOKEN: 'local-command-test',
      INKWELL_API_URL: apiUrl || 'http://127.0.0.1:1',
      ...environment,
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

test('shared OIDC workflow keeps preview --publish as a draft and publishes production', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inkwell-command-oidc-'));
  let target: 'preview' | 'production' = 'preview';
  const requests: Array<{path:string;method:string;body:Record<string,unknown>}> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const text=Buffer.concat(chunks).toString('utf8');
    const body=text && request.headers['content-type']?.startsWith('application/json') ? JSON.parse(text) as Record<string,unknown> : {raw:text};
    const path=new URL(request.url!,'http://local').pathname;
    requests.push({path,method:request.method!,body});
    response.setHeader('content-type','application/json');
    if(path==='/oidc') {
      assert.equal(request.headers.authorization,'Bearer runner-oidc-request');
      assert.equal(new URL(request.url!,'http://local').searchParams.get('audience'),'inkwell-deploy');
      response.end(JSON.stringify({value:'local-identity-jwt'}));
    } else if(path==='/api/v1/github/actions/exchange') {
      assert.deepEqual(body,{game:'engine-demo',token:'local-identity-jwt'});
      response.end(JSON.stringify({token:'ink_gha_local',deployment:{id:'deployment123',target}}));
    } else {
      assert.equal(request.headers.authorization,'Bearer ink_gha_local');
      if(path.endsWith('/builds')) response.end(JSON.stringify({build:{publicId:buildId},alreadyUploaded:true}));
      else if(path.endsWith('/backend/deployments')) response.end(JSON.stringify({activation:'active'}));
      else if(path.endsWith('/finalize')) response.end(JSON.stringify({published:body.publish===true}));
      else if(path==='/api/v1/github/actions/deployments/deployment123') response.end(JSON.stringify({ok:true}));
      else {response.statusCode=404;response.end(JSON.stringify({error:'Unexpected request'}));}
    }
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();
  assert(address&&typeof address!=='string');
  const apiUrl=`http://127.0.0.1:${address.port}`;
  const environment={INKWELL_TOKEN:'',ACTIONS_ID_TOKEN_REQUEST_URL:`${apiUrl}/oidc`,ACTIONS_ID_TOKEN_REQUEST_TOKEN:'runner-oidc-request'};
  try {
    await mkdir(join(root,'dist'));
    await writeFile(join(root,'dist/index.html'),'<canvas></canvas>');
    await writeFile(join(root,'inkwell.config.js'),`export default ${JSON.stringify({game:'engine-demo',client:{directory:'dist'},backend:{entry:'server.ts'}})};\n`);
    // Preview must not even attempt to compile the deliberately absent backend.
    const preview=await command(root,['deploy','--publish'],apiUrl,cli,environment);
    assert.match(preview.stdout,/Draft uploaded/);
    assert.doesNotMatch(preview.stdout,/Build published/);
    assert.equal(requests.find(request=>request.path.endsWith('/finalize'))?.body.publish,false);
    assert(!requests.some(request=>request.path.endsWith('/backend/deployments')));
    assert.equal(requests.at(-1)?.body.status,'succeeded');
    requests.length=0;
    target='production';
    await writeFile(join(root,'server.ts'),"export default {__inkwellBackend:1, fetch(){return new Response('ok')}};\n");
    const production=await command(root,['deploy','--publish'],apiUrl,cli,environment);
    assert.match(production.stdout,/Build published/);
    const backendIndex=requests.findIndex(request=>request.path.endsWith('/backend/deployments'));
    const finalizeIndex=requests.findIndex(request=>request.path.endsWith('/finalize'));
    assert(backendIndex>=0 && backendIndex<finalizeIndex,'Backend must be deployed before explicit client publication.');
    assert.equal(requests[finalizeIndex]!.body.publish,true);
    assert.equal(requests.at(-1)?.body.status,'succeeded');
  } finally {
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    await rm(root,{recursive:true,force:true});
  }
});
