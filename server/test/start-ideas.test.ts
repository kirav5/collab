// Start ideas are things someone on Collab can answer: every request names a listing that's there now. One idea may be
// about the person's own offering. Without the model, the nearest listings become plain requests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide } from "../src/ai/decide.ts";
import { StartIdeasTask } from "../src/core/intake.ts";

const available = [{ id: "a1", title: "Weekend street food walk · Basavanagudi", where: "Basavanagudi" }, { id: "a2", title: "Yoga classes · online", where: "Online" },
  { id: "a3", title: "Home deep cleaning · Koramangala", where: "Koramangala" }, { id: "a4", title: "Maths tuition · online", where: "Online" }];
const base = { area: "Koramangala", offers: ["Study table"], asked: [], bought: [], available };
const model = (ideas: unknown) => ({ name: "t", complete: async () => JSON.stringify({ ideas }) }) as any;

test("ideas that point at no listing are refused; the rest keep one per listing", async () => {
  const d = await decide(model([
    { label: "street food walk", text: "Find me a weekend street food walk in Basavanagudi", ref: "a1" },
    { label: "pottery class", text: "Find me a pottery class in Koramangala", ref: "zz" },
    { label: "street food again", text: "Street food walk this Sunday", ref: "a1" },
    { label: "yoga online", text: "Beginner yoga classes online", ref: "a2" },
    { label: "home cleaning", text: "Deep clean my 2BHK in Koramangala", ref: "a3" },
    { label: "update: study table", text: "Update my study table listing", ref: null }]), StartIdeasTask, base);
  assert.equal(d.byModel, true);
  assert.deepEqual(d.output.map(x => x.ref ?? null), ["a1", "a2", "a3", null], "no made-up listing, no repeats, one own idea");
});

test("without enough grounded ideas, the nearest listings become the ideas", async () => {
  const d = await decide(model([{ label: "pottery class", text: "Find me a pottery class", ref: null }]), StartIdeasTask, base);
  assert.equal(d.byModel, false);
  assert.deepEqual(d.output.filter(x => x.ref).map(x => x.ref), ["a1", "a2", "a3", "a4"]);
  assert.match(d.output[1].text, /online/);
});
