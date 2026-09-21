// 5 分おきに GitHub の workflow_dispatch を叩いて、予約の自動処理（sync-bookings）を走らせる。
// 実体は GitHub Actions 側で動くので、ログは GitHub の Actions タブで見る。
export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(dispatch(env));
  },
  // ブラウザで開いたときの確認用。何も実行しない
  async fetch() {
    return new Response('roots-line-sync-dispatch: cron で GitHub Actions を起動します（5 分おき）', {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  },
};

export async function dispatch(env, fetchImpl = fetch) {
  if (!env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN が未設定です（npx wrangler secret put GITHUB_TOKEN）');
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/${env.WORKFLOW_FILE}/dispatches`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'roots-line-sync-dispatch',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref: env.GIT_REF }),
  });
  if (res.status !== 204) {
    const text = await res.text().catch(() => '');
    throw new Error(`workflow_dispatch に失敗: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  console.log(`dispatched ${env.WORKFLOW_FILE}@${env.GIT_REF}`);
}
