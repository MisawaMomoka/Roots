import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listStaffWithCalendar, issueLink, shortenLink } from '../google-link.mjs';

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

test('google-link: 短縮リンクは古い同名リンクを消してから作り、短い URL を返す', async () => {
  const calls = [];
  const api = async (method, path, { body } = {}) => {
    calls.push(`${method} ${path}`);
    if (method === 'GET' && path === '/api/tracked-links') return { data: [{ id: 'old-1', name: 'gcal-connect:徳原' }, { id: 'x', name: '講義動画ページ' }] };
    if (method === 'DELETE') return { success: true };
    if (method === 'POST' && path === '/api/tracked-links') {
      assert.equal(body.name, 'gcal-connect:徳原');
      assert.match(body.originalUrl, /^https:\/\/accounts\.google\.com\//);
      return { data: { id: 'new-1', trackingUrl: 'https://roots-line.re-tro.workers.dev/t/AbCdEfG' } };
    }
    throw new Error(`mock にないAPI: ${method} ${path}`);
  };
  const short = await shortenLink(api, 'acc2', '徳原', 'https://accounts.google.com/o/oauth2/v2/auth?state=xyz&scope=long');
  assert.equal(short, 'https://roots-line.re-tro.workers.dev/t/AbCdEfG');
  assert.deepEqual(calls, ['GET /api/tracked-links', 'DELETE /api/tracked-links/old-1', 'POST /api/tracked-links']);
});
