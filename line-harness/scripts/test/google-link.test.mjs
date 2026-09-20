import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listStaffWithCalendar, issueLink } from '../google-link.mjs';

test('google-link: 担当者ごとの接続状態を読み、指定した人の接続リンクを発行する', async () => {
  const calls = [];
  const api = async (method, path, { query } = {}) => {
    calls.push(`${method} ${path}`);
    assert.equal(query.account_id, 'acc2');
    if (path === '/api/booking/admin/staff') {
      return { staff: [{ id: 'st-1', name: '徳原', display_name: '徳原さん' }, { id: 'st-2', name: '池端', display_name: '池端さん' }] };
    }
    if (path === '/api/booking/admin/staff/st-1/google-calendar') {
      return { connection: { is_active: 1, calendar_id: 'tokuhara@example.com' }, oauth: { configured: true } };
    }
    if (path === '/api/booking/admin/staff/st-2/google-calendar') return { connection: null, oauth: { configured: true } };
    if (path === '/api/booking/admin/staff/st-2/google-calendar/oauth/start') {
      return { authorization_url: 'https://accounts.google.com/o/oauth2/v2/auth?state=xyz' };
    }
    throw new Error(`mock にないAPI: ${method} ${path}`);
  };
  const staff = await listStaffWithCalendar(api, 'acc2');
  assert.deepEqual(staff.map((s) => [s.name, s.connected]), [['徳原', true], ['池端', false]]);
  assert.equal(staff[0].detail, 'tokuhara@example.com');
  assert.equal(staff.oauthConfigured, true);
  const url = await issueLink(api, 'acc2', 'st-2');
  assert.match(url, /^https:\/\/accounts\.google\.com\//);
});
