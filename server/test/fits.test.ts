// "Why it fits you" (web/js/fits.js): reasons a listing suits the owner, from their private notes, worked out on the
// device by word overlap alone — quoted from both sides, never guessed, and never sent anywhere.
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-ignore browser module, pure functions
import { fitsReasons, stem } from "../../web/js/fits.js";

const flat = {
  text: "Sunny 2BHK flat. Pets welcome. Fiber wifi 200 Mbps. Car parking.",
  offer: { title: "Sunny 2BHK flat", details: "Pets welcome. Fiber wifi 200 Mbps. Car parking.", attributes: { pets: "allowed", bedrooms: "2", furnished: "semi" } },
};
const tidy = (s: string) => s.toLowerCase().replace(/\s+/g, " ");
const said = (l: any) => tidy([l.text, l.offer.title, l.offer.details, ...Object.entries(l.offer.attributes).map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`)].join(" | "));

test("a note that shares a word with the listing becomes a reason, attributes first, at most two", () => {
  const notes = [{ text: "I have two pets, a small dog", createdAt: 1 }, { text: "I work from home and need fast wifi", createdAt: 2 }, { text: "My sister visits on Sundays", createdAt: 3 }];
  const r = fitsReasons(notes, flat, "2BHK flat in Indiranagar");
  assert.deepEqual(r, [{ reason: "pets allowed", note: "I have two pets" }, { reason: "Fiber wifi 200 Mbps", note: "from home and need fast wifi" }]);
  assert.ok(fitsReasons([...notes, { text: "pets are family", createdAt: 9 }, { text: "wifi matters", createdAt: 9 }, { text: "my car", createdAt: 9 }], flat).length <= 2);
  assert.equal(stem("ponies"), "pony"); assert.equal(stem("boxes"), "box"); assert.equal(stem("pets"), "pet"); assert.equal(stem("glass"), "glass");
});

test("no shared word, words the request already says, negations and disagreeing numbers give no reason", () => {
  assert.deepEqual(fitsReasons([{ text: "I love hiking in the hills" }], flat), [], "nothing in common");
  assert.deepEqual(fitsReasons([{ text: "I want a sunny flat" }], flat, "Sunny flat"), [], "the request's own words don't count");
  assert.deepEqual(fitsReasons([{ text: "I don't own a car" }, { text: "never had pets" }], flat), [], "a note that says no");
  assert.deepEqual(fitsReasons([{ text: "I have pets" }], { offer: { title: "Room", attributes: { pets: "not allowed" } } }), [], "a listing that says no");
  assert.deepEqual(fitsReasons([{ text: "We need 3 bedrooms" }], flat), [], "3 bedrooms is not bedrooms 2");
  assert.deepEqual(fitsReasons([{ text: "We need 2 bedrooms" }], flat), [{ reason: "bedrooms 2", note: "We need 2 bedrooms" }]);
  assert.deepEqual(fitsReasons([{ text: "the and with have this" }], flat), [], "grammar words alone say nothing");
  assert.deepEqual(fitsReasons([], flat), []); assert.deepEqual(fitsReasons(null, flat), []); assert.deepEqual(fitsReasons([{ text: "pets" }], {}), []);
});

test("every reason is quoted from the listing and every note fragment from the note, sharing a word", () => {
  const notes = [{ text: "Our family has two cats and a parrot; the parrot is loud in the mornings, so a balcony would help a lot" }];
  const listing = { text: "Big 3BHK with a long balcony facing the park, cats and dogs welcome", offer: { title: "3BHK, park view", details: "Big 3BHK with a long balcony facing the park, cats and dogs welcome", attributes: { pet_friendly: "cats welcome" } } };
  const r = fitsReasons(notes, listing);
  assert.equal(r.length, 1, "one reason per note");
  for (const { reason, note } of r) {
    assert.ok(said(listing).includes(tidy(reason)), `"${reason}" is in the listing`);
    assert.ok(tidy(notes[0].text).includes(tidy(note)), `"${note}" is in the note`);
    assert.ok(reason.split(/\s+/).length <= 6 && note.split(/\s+/).length <= 6, "short");
    const words = (s: string) => new Set<string>((s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map(stem));
    assert.ok([...words(reason)].some(w => w.length >= 3 && words(note).has(w)), "they share a word");
  }
  assert.deepEqual(r[0], { reason: "pet friendly cats welcome", note: "has two cats and a parrot" });
});

test("pure: no network, no storage, inputs untouched, same answer every time", () => {
  const g = globalThis as any, saved = { fetch: g.fetch, localStorage: g.localStorage, indexedDB: g.indexedDB };
  const boom = () => { throw new Error("fitsReasons must not reach the network or storage"); };
  g.fetch = boom; g.localStorage = new Proxy({}, { get: boom }); g.indexedDB = new Proxy({}, { get: boom });
  try {
    const freeze = (o: any): any => { Object.values(o).forEach(v => v && typeof v === "object" && freeze(v)); return Object.freeze(o); };
    const notes = freeze([{ text: "I have two pets", createdAt: 1 }]), listing = freeze(structuredClone(flat));
    const a = fitsReasons(notes, listing), b = fitsReasons(notes, listing);
    assert.deepEqual(a, b); assert.equal(a.length, 1);
    assert.deepEqual(listing, flat);
  } finally { Object.assign(g, saved); }
});
