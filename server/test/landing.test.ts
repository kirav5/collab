// The front page (web/js/landing.js): the Collab site whenever collab-55.web.app is opened in a browser; Collab
// itself for the installed app, links, the site's Try and a reload inside Collab.
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-ignore browser module, pure functions
import { inApp, shouldLand } from "../../web/js/landing.js";

test("the plain address in a browser shows the site — for everyone, signed in or not", () => {
  assert.equal(shouldLand(""), true);
  assert.equal(shouldLand("?install"), true, "the site's own QR");
});

test("the installed app, links, the site's Try and a reload inside Collab open Collab", () => {
  assert.equal(shouldLand("", { installed: true }), false);
  assert.equal(shouldLand("?try"), false, "Try it now / Open Collab");
  assert.equal(shouldLand("", { opened: true }), false, "a reload or update of Collab in this tab");
  assert.equal(shouldLand("?to=riya"), false, "a shop or person QR");
  assert.equal(shouldLand("?screen=requests&engagement=e1"), false, "a notification");
  assert.equal(shouldLand("?landing", { installed: true, opened: true }), true, "?landing always shows it");
});

test("in-app is per tab and survives blocked storage", () => {
  assert.equal(inApp({ getItem: () => "1" }), true);
  assert.equal(inApp({ getItem: () => null }), false);
  assert.equal(inApp({ getItem: () => { throw new Error("blocked"); } }), false);
});
