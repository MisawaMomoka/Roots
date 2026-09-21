import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatch } from '../../dispatch-worker/src/index.mjs';

const env = { GITHUB_TOKEN: 'tok', GITHUB_OWNER: 'o', GITHUB_REPO: 'r', WORKFLOW_FILE: 'wf.yml', GIT_REF: 'main' };

test('dispatch-worker: workflow_dispatch API を正しい URL・ヘッダー・ref で呼ぶ', async () => {
  let seen = null;
  await dispatch(env, async (url, init) => { seen = { url, init }; return new Response(null, { status: 204 }); });
  assert.equal(seen.url, 'https://api.github.com/repos/o/r/actions/workflows/wf.yml/dispatches');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers.Authorization, 'Bearer tok');
  assert.deepEqual(JSON.parse(seen.init.body), { ref: 'main' });
});

test('dispatch-worker: 204 以外はエラーにする / トークン未設定もエラー', async () => {
  await assert.rejects(() => dispatch(env, async () => new Response('bad', { status: 401 })), /HTTP 401/);
  await assert.rejects(() => dispatch({ ...env, GITHUB_TOKEN: '' }), /GITHUB_TOKEN/);
});
