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
test('service worker does not cache pickup status, public receipts or version checks; the shell opens from the device, the rest from the network', async () => {
  const handlers: any = {};
  let stored: Response | undefined = new Response('old version');
  runInNewContext(readFileSync(new URL('../../web/sw.js', import.meta.url), 'utf8'), {
    self: { addEventListener: (name: string, fn: any) => handlers[name] = fn }, location: { origin: 'https://collab.test' }, URL, Response,
    fetch: async () => new Response('new version', { status: 200 }),
    caches: { match: async () => stored, open: async () => ({ put: () => {} }) },
    setTimeout: () => {}, importScripts: () => { throw new Error('local'); },
  });
  const get = (path: string) => { let response: any = null;
    handlers.fetch({ request: { method: 'GET', url: 'https://collab.test' + path }, respondWith: (r: any) => response = r, waitUntil: () => {} });
    return response; };
  for (const path of ['/public/pickup/id?code=secret', '/public/receipts/id?code=secret', '/api/chats', '/version.txt', '/pickup.html', '/verify.html'])
    assert.equal(get(path), null, path);
  assert.equal(await (await get('/js/app.js')).text(), 'old version', 'a shell file opens from the device at once (a deployment brings a new shell)');
  assert.equal(await (await get('/js/not-in-shell.js')).text(), 'new version', 'anything else: network first');
  stored = undefined;
  assert.equal(await (await get('/js/app.js')).text(), 'new version', 'no device copy yet: the network');
});
