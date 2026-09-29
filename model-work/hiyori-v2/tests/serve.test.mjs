// Regression tests for review finding 5 and the static allowlist.
import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveRequest, createServer} from '../tools/serve.mjs';

test('malformed escapes resolve to 400 without throwing', () => {
  for (const url of ['/%', '/%E0%A4%A', '/work/%ZZ', '/%C0%AF']) {
    assert.doesNotThrow(() => resolveRequest(url));
    assert.equal(resolveRequest(url).status, 400, url);
  }
});

test('allowlist: serves the workbench, original runtime files are read-only subset', () => {
  for (const ok of ['/work/demo/index.html', '/work/src/rig.mjs', '/work/rig/hiyori-v2.rig.json', '/work/build/finger-atlas.png',
    '/hiyori/hiyori_pro_t11.moc3', '/hiyori/hiyori_pro_t11.2048/texture_00.png', '/vendor/live2dcubismcore.js']) assert.equal(resolveRequest(ok).status, 200, ok);
  for (const no of ['/work/source/hiyori_pro_t11.cmo3', '/work/reference/hand-L-open-master-v1.png', '/work/../../.env', '/work/%2e%2e/%2e%2e/.env',
    '/work/demo/..%2f..%2fsource/ReadMe.txt', '/hiyori/hiyori_pro_t11.model3.json', '/hiyori/../../server.mjs', '/package.json', '/work\\src\\rig.mjs', 'relative', '']) {
    assert.notEqual(resolveRequest(no).status, 200, no);
  }
  assert.deepEqual(resolveRequest('/'), {status: 302, location: '/work/demo/index.html'});
});

test('server keeps serving after malformed requests', async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const {port} = server.address();
  try {
    const bad = await fetch(`http://127.0.0.1:${port}/%E0%A4%A`);
    assert.equal(bad.status, 400);
    const bad2 = await fetch(`http://127.0.0.1:${port}/%`);
    assert.equal(bad2.status, 400);
    const ok = await fetch(`http://127.0.0.1:${port}/work/rig/hiyori-v2.rig.json`);
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).schema, 'hiyori-v2-rig/1');
    const post = await fetch(`http://127.0.0.1:${port}/work/rig/hiyori-v2.rig.json`, {method: 'POST', body: 'x'});
    assert.equal(post.status, 405);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
