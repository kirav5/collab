import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
// @ts-ignore Shared browser module.
import { shouldReload } from '../../web/js/version.js';

test('version updates reload changed versions, defer while editing and tolerate offline/initial state', () => {
  assert.equal(shouldReload('one', 'two', false), true);
  assert.equal(shouldReload('one', 'two', true), false);
  assert.equal(shouldReload('one', 'one', false), false);
  assert.equal(shouldReload('one', null, false), false);
  assert.equal(shouldReload(null, 'two', false), false);
});
test('service worker does not cache pickup status, public receipts or version checks; new shell wins', async () => {
  const handlers: any = {}, cached: any[] = [];
  runInNewContext(readFileSync(new URL('../../web/sw.js', import.meta.url), 'utf8'), {
    self: { addEventListener: (name: string, fn: any) => handlers[name] = fn }, location: { origin: 'https://collab.test' }, URL, Response,
    fetch: async () => new Response('new version', { status: 200 }),
    caches: { match: async () => new Response('old version'), open: async () => ({ put: (...args: any[]) => cached.push(args) }) },
    setTimeout: () => {}, importScripts: () => { throw new Error('local'); },
  });
  for (const path of ['/public/pickup/id?code=secret', '/public/receipts/id?code=secret', '/api/chats', '/version.txt', '/pickup.html', '/verify.html']) {
    let intercepted = false; handlers.fetch({ request: { method: 'GET', url: 'https://collab.test' + path }, respondWith: () => intercepted = true });
    assert.equal(intercepted, false, path);
  }
  let response: any;
  handlers.fetch({ request: { method: 'GET', url: 'https://collab.test/js/app.js' }, respondWith: (r: any) => response = r });
  assert.equal(await (await response).text(), 'new version');
});
