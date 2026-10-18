// The front page (web/js/landing.js): who sees it, and who goes straight into Collab.
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-ignore browser module, pure functions
import { returning, shouldLand } from "../../web/js/landing.js";

const store = (o: Record<string, string>) => ({ get length() { return Object.keys(o).length; }, key: (i: number) => Object.keys(o)[i] ?? null, getItem: (k: string) => o[k] ?? null });

test("someone new in a browser sees the front page; the installed app, links and returning visitors go straight in", () => {
  assert.equal(shouldLand(""), true);
  assert.equal(shouldLand("?install"), true, "the front page's own QR");
  assert.equal(shouldLand("", { installed: true }), false, "the installed app opens Collab");
  assert.equal(shouldLand("", { before: true }), false, "used Collab here before");
  assert.equal(shouldLand("?to=riya"), false, "a shop or person QR opens them");
  assert.equal(shouldLand("?screen=requests&engagement=e1"), false, "a notification opens its conversation");
  assert.equal(shouldLand("?landing", { installed: true, before: true }), true, "?landing always shows it");
});

test("returning: a profile kept in this browser, or Try tapped once", () => {
  assert.equal(returning(store({})), false);
  assert.equal(returning(store({ "collab.me.u1": "null" })), false, "an account gone since");
  assert.equal(returning(store({ "collab.me.u1": "{\"handle\":\"fr\"}" })), true);
  assert.equal(returning(store({ "collab.tried": "1" })), true);
  assert.equal(returning({ get length(): number { throw new Error("blocked"); } } as any), false, "storage blocked");
});

test("coming back from the site's Try opens Collab, not the site again", () => {
  assert.equal(shouldLand("?try"), false);
});
