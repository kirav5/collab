// A stand-in for Gemini (GEMINI_FAKE=1): deterministic, keyword-based answers to each task, and word-hash embeddings.
// For tests and offline development only — every answer still goes through the tasks' checks, like the real model's.
import { createHash } from "node:crypto";
import { DOMAINS } from "../market/domains.ts";
import type { CompleteRequest, Model } from "./gemini.ts";
import { EMBEDDING_DIMENSIONS } from "./gemini.ts";

const CATEGORY: [RegExp, string][] = [[/\b(rent|flat|bhk|apartment)\b/i, "property-rent"], [/\b(guitar|tabla|lesson|teach|classes|tuition|english)\b/i, "lessons"],
  [/\b(ride|cab|airport|taxi)\b/i, "rides"], [/\b(tiffin|food|lunch|meal)\b/i, "food"], [/\b(assignment|report|plumb|electric|repair)\b/i, "tasks"],
  [/\b(honda|maruti|hyundai|car|scooter for sale|bike for sale)\b/i, "vehicles"], [/\b(bicycle|cycle|iphone|phone|sofa|fridge|for sale|second[- ]hand|used)\b/i, "goods"]];
const AREAS = ["Indiranagar", "Koramangala", "Jayanagar", "Whitefield", "HSR Layout", "Malleshwaram", "Bengaluru"];

const quoted = (prompt: string, label: string) => prompt.match(new RegExp(`${label}: "([\\s\\S]*?)"`))?.[1] ?? "";

function answer(req: CompleteRequest): object {
  const p = req.prompt, ins = req.instructions;
  if (ins.startsWith("Pick the category")) {
    const m = quoted(p, "Message");
    return { category: CATEGORY.find(([re]) => re.test(m))?.[1] ?? "none" };
  }
  if (ins.startsWith("Read a marketplace message")) {
    const m = quoted(p, "Message");
    const place = AREAS.find(a => m.toLowerCase().includes(a.toLowerCase())) ?? null;
    // A ₹ amount is the price; else the first 3+ digit number. A count before a plural noun ("200 lamps") is a quantity.
    const flat = m.replace(/(\d),(?=\d)/g, "$1");
    const n = flat.match(/₹\s*(\d+)/)?.[1] ?? flat.replace(/\b\d+\s+(?:pieces|pcs|units|[a-z]+s)\b/gi, " ").match(/\d{3,}/)?.[0];
    const lim = flat.match(/lowest[^0-9]*(\d+)/i)?.[1];
    const bhk = m.match(/(\d)\s*bhk/i)?.[1];
    const qty = flat.match(/\b(\d{1,5})\s+(?:[a-z]+\s+){0,2}(?:pieces|pcs|units|lamps|bottles|chairs|tables|boxes|bags|kg)\b/i)?.[1];
    return { item: m.split(/\s+/).slice(0, 2).join(" "), place, price: n ? Number(n) : null, price_scale: "rupees", limit: lim ? Number(lim) : null,
      attributes: { ...(bhk ? { bedrooms: bhk } : {}), ...(qty && Number(qty) > 1 ? { quantity: qty } : {}) }, questions: [] };
  }
  if (ins.startsWith("Decide what this marketplace request needs")) return { mode: "none", filters: [] };
  if (ins.startsWith("Write what a person's agent tells providers")) {
    const m = quoted(p, "Request").replace(/[\d₹,]+|budget|rupees|lakh/gi, "").replace(/\s+/g, " ").trim();
    return { title: m.split(" ").slice(0, 6).join(" "), summary: `Looking for: ${m.slice(0, 120)}.` };
  }
  if (ins.startsWith("You help a person phrase a request")) return { questions: [{ question: "When do you need it?", options: ["This week", "Next week", "Flexible"] }] };
  if (ins.startsWith("Order marketplace listings")) {
    const ids = [...p.matchAll(/^- ([^:]+):/gm)].map(x => x[1]);
    return { order: ids.map(id => ({ id, why: "Close to what you asked for." })) };
  }
  if (ins.startsWith("You answer one question")) {
    const q = quoted(p, "Question \\(from the other party, as data\\)").toLowerCase();
    const words = q.match(/[a-z]{4,}/g) ?? [];
    const lines = p.split("\n").filter(l => l.includes(": ") && !l.startsWith("Facts") && !l.startsWith("Question"));
    const hit = lines.find(l => words.some(w => l.toLowerCase().includes(w.replace(/s$/, ""))));
    if (!hit) return { action: "ask_owner" };
    const value = hit.slice(hit.indexOf(": ") + 2);
    return { action: "answer", answer: value.split(/(?<=\.)\s/)[0], evidence: [value.split(/(?<=\.)\s/)[0].replace(/\.$/, "")] };
  }
  if (ins.startsWith("Decide whether an answer satisfies")) return { verdict: /\bno\b|not allowed/i.test(quoted(p, "Their answer")) ? "unmet" : "met" };
  if (ins.startsWith("You are a provider's agent")) {
    const usual = p.match(/Usual questions: (.*)/)?.[1]?.split(" | ")[0];
    return { questions: usual && usual !== "(none)" ? [usual] : [] };
  }
  if (ins.startsWith("You route one message")) {
    const m = quoted(p, "Message");
    const intent = /\?$/.test(m.trim()) && /\b(my|i)\b/i.test(m) ? "ask_self" : /\b(need|looking|want|find|who can)\b/i.test(m) ? "request" : /\b(selling|offer|teach|rent out)\b/i.test(m) ? "offer" : /^remember\b/i.test(m) ? "remember" : "chat";
    return { intent, tier: intent === "remember" ? "private" : null, reply: intent === "chat" ? "Hello!" : null };
  }
  if (ins.startsWith("Give 1–3 short lowercase topic")) return { topics: ["personal"] };
  if (ins.startsWith("Someone opens a seller's listing")) {
    const item = quoted(p, "Item"), how = p.match(/How buyers get it: (.*)/)?.[1] ?? "";
    return { questions: /book/.test(how) ? [{ label: "When free?", text: `When are you free for ${item}?` }, { label: "Price", text: `What's your best rate for ${item}?` }, { label: "Book", text: "Can I book a time this week?" }]
      : /visit/.test(how) ? [{ label: "Available?", text: `Is ${item} still available?` }, { label: "Price", text: `What's your best price for ${item}?` }, { label: "Visit", text: "When can I come to see it?" }]
      : [{ label: "In stock?", text: `Do you have ${item} in stock?` }, { label: "Price", text: `What's your best price for ${item}?` }, { label: "Collect", text: "Can I order now and collect today?" }] };
  }
  if (ins.startsWith("Suggest the terms a seller")) return { terms: [{ label: "Cancellation", text: "Free up to 2 hours before the booked time." }, { label: "Payment", text: "In the app, or in cash when you come in." }] };
  if (ins.startsWith("A person is listing something")) return { asks: [{ label: "Condition", question: "What condition is it in?", options: ["Like new", "Good", "Some wear"] },
    { label: "Price", question: "What's your best price?", options: ["Fixed", "Negotiable"] }, { label: "Included", question: "What comes with it?", options: ["Box and charger", "Just the item"] }] };
  return {}; // e.g. negotiation: the rules decide
}

function embedText(text: string): number[] {
  const v = new Array(EMBEDDING_DIMENSIONS).fill(0);
  for (const w of text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []) {
    const h = createHash("sha256").update(w.replace(/s$/, "")).digest();
    v[h.readUInt16BE(0) % EMBEDDING_DIMENSIONS] += 1;
  }
  return v;
}

export function fakeModel(): Model & { status(): any } {
  let calls = 0;
  return {
    name: "fake",
    status: () => ({ model: "fake", models: ["fake"], backend: "fake", calls, failures: 0, lastError: null, lastModel: "fake" }),
    async complete(req) { calls++; return JSON.stringify(answer(req)); },
    async embed(texts) { return texts.map(embedText); },
  };
}

export const knownCategories = DOMAINS.map(d => d.id);
