// A community post is shaped by Gemini from plain words, but only what was written survives: places it names, a number
// it states, a time it mentions. Without the model it goes up as written, for the person to pick the kind.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PostTask, istSeconds } from "../src/core/communities.ts";

const input = (text: string) => ({ text, community: "Embassy Tech Village", area: "Whitefield, Bengaluru", now: "2026-10-17T14:00 Sat" });

test("a shaped post keeps only places, numbers and times the words contain", () => {
  const i = input("Anyone driving from HSR Layout to the office at 9am tomorrow? 2 seats");
  const ok = PostTask.validate({ kind: "trip", title: "Ride from HSR, 9 am", from: "HSR Layout", to: null, place: null, when: "2026-10-18T09:00", spots: 2 }, i)!;
  assert.equal(ok.from, "HSR Layout"); assert.equal(ok.spots, 2); assert.equal(ok.when, "2026-10-18T09:00");
  const made = PostTask.validate({ kind: "trip", title: "Ride from HSR", from: "Marathahalli", to: "Electronic City", place: null, when: "2026-10-18T09:00", spots: 3 }, i)!;
  assert.equal(made.from, null, "a place the words don't name"); assert.equal(made.to, null); assert.equal(made.spots, null, "a number the words don't state");
  const noTime = PostTask.validate({ kind: "ask", title: "Need a drill", from: null, to: null, place: null, when: "2026-10-18T09:00", spots: 4 }, input("Can anyone lend me a drill?"))!;
  assert.equal(noTime.when, null, "no day or time in the words"); assert.equal(noTime.spots, null, "spots only for trips and groups");
  assert.equal(PostTask.validate({ kind: "offer", title: "Call 98450 12345", from: null, to: null, place: null, when: null, spots: null }, i), null, "no contact details in a title");
  assert.ok(PostTask.validate({ kind: "group", title: "Rice bulk order", from: null, to: null, place: null, when: null, spots: 5 }, input("Pooling a bulk rice order, need five people"))!.spots === 5, "numbers in words count");
});

test("a group counts everyone; places must be named whole; a time needs words that say one", () => {
  const g = (text: string, spots: number) => PostTask.validate({ kind: "group", title: "Bulk rice order", from: null, to: null, place: null, when: null, spots }, input(text))!.spots;
  assert.equal(g("Pooling a rice order, need 3 more people", 4), 4, "3 more and the poster");
  assert.equal(g("Need 1 person to split a Netflix plan", 1), null, "a group of one can't be joined");
  const at = (text: string, place: string) => PostTask.validate({ kind: "offer", title: "Desk", from: null, to: null, place, when: null, spots: null }, input(text))!.place;
  assert.equal(at("Selling my old desk", "Old Airport Road"), null, "a common first word isn't a place");
  assert.equal(at("Selling my desk in HSR Layout", "HSR Layout, Bengaluru"), "HSR Layout, Bengaluru");
  const when = (text: string) => PostTask.validate({ kind: "offer", title: "Chairs", from: null, to: null, place: null, when: "2026-10-18T09:00", spots: null }, input(text))!.when;
  assert.equal(when("Selling 2 chairs"), null, "a number isn't a time");
  assert.equal(when("Selling 2 chairs, pick up Sunday"), "2026-10-18T09:00");
});

test("without the model it's posted as written; India time converts to the right instant", () => {
  assert.deepEqual(PostTask.fallback(input("  Lost a black umbrella near the  food court  ")), { kind: "ask", title: "Lost a black umbrella near the food court", from: null, to: null, place: null, when: null, spots: null });
  assert.equal(istSeconds("2026-10-18T09:00"), Date.UTC(2026, 9, 18, 3, 30) / 1000);
  assert.equal(istSeconds(null), null); assert.equal(istSeconds("tomorrow"), null);
});
