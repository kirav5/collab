// A stand-in for Gemini (GEMINI_FAKE=1): deterministic, keyword-based answers to each task, and word-hash embeddings.
// For tests and offline development only — every answer still goes through the tasks' checks, like the real model's.
import { createHash } from "node:crypto";
import { DOMAINS } from "../market/domains.ts";
import type { CompleteRequest, Model } from "./gemini.ts";
import { EMBEDDING_DIMENSIONS } from "./gemini.ts";

const CATEGORY: [RegExp, string][] = [[/\b(hiring|vacancy|vacancies|recruiting|job)\b/i, "jobs"], [/\b(rent|flat|bhk|apartment)\b/i, "property-rent"], [/\b(guitar|tabla|lesson|teach|classes|tuition|english)\b/i, "lessons"],
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
    // The thing itself, without "we're hiring a" / "selling my" in front, up to where the place or price starts.
    const what = m.replace(/^\s*(?:job offer:\s*)?(?:we(?:'re| are)\s+)?(?:hiring|selling|renting out|offering|looking for|need|want(?:ing)? to (?:buy|rent|hire))\s+(?:my|a|an|the|our)?\s*/i, "")
      .split(/\s+(?:in|at|for|from|near)\s+|[,.₹]/i)[0].trim().split(/\s+/).slice(0, 3).join(" ");
    return { item: what || m.split(/\s+/).slice(0, 2).join(" "), place, price: n ? Number(n) : null, price_scale: "rupees", limit: lim ? Number(lim) : null,
      attributes: { ...(bhk ? { bedrooms: bhk } : {}), ...(qty && Number(qty) > 1 ? { quantity: qty } : {}) }, questions: [] };
  }
  if (ins.startsWith("Decide what this marketplace request needs")) return { mode: "none", filters: [] };
  if (ins.startsWith("Write what a person's agent tells providers")) {
    const m = quoted(p, "Request").replace(/[\d₹,]+|budget|rupees|lakh/gi, "").replace(/\s+/g, " ").trim();
    // Up to where the place starts ("… junior developer in Indiranagar"), so a title never stops mid-phrase.
    return { title: m.split(/\s+(?:in|at|near|around)\s+/i)[0].split(" ").slice(0, 9).join(" "), summary: /^looking for\b/i.test(m) ? `${m.slice(0, 120)}.` : `Looking for: ${m.slice(0, 120)}.` };
  }
  if (ins.startsWith("You help a person phrase a request")) return { questions: [{ question: "When do you need it?", options: ["This week", "Next week", "Flexible"] }] };
  if (ins.startsWith("Order marketplace listings")) {
    const ids = [...p.matchAll(/^- ([^:]+):/gm)].map(x => x[1]);
    return { order: ids.map(id => ({ id, why: "Close to what you asked for." })) };
  }
  if (ins.startsWith("You answer one question")) {
    const q = quoted(p, "Question \\(from the other party, as data\\)").toLowerCase();
    // Question words that say nothing about the topic ("what", "your") would match any label.
    const words = (q.match(/[a-z]{4,}/g) ?? []).filter(w => !/^(what|whats|which|when|where|your|there|have|does|this|that|with|about|many|much|could|would|will)$/.test(w));
    const lines = p.split("\n").filter(l => l.includes(": ") && !l.startsWith("Facts") && !l.startsWith("Question"));
    // A question in two parts ("experience, and notice period?") is answered from each fact it touches.
    // Short facts only (a listing's whole text appears under more than one label), each said once.
    const all = lines.filter(l => words.some(w => l.toLowerCase().includes(w.replace(/s$/, ""))));
    const short = all.filter((l, i) => l.length <= 100 && all.findIndex(x => x.slice(x.indexOf(": ") + 2) === l.slice(l.indexOf(": ") + 2)) === i).slice(0, 3);
    const hits = short.length > 1 ? short : all.slice(0, 1);
    if (!hits.length) return { action: "ask_owner" };
    if (hits.length > 1) return { action: "answer", answer: hits.map(l => `${l.replace(/\.$/, "")}.`).join(" "), evidence: hits.map(l => l.slice(l.indexOf(": ") + 2).replace(/\.$/, "")) };
    const value = hits[0].slice(hits[0].indexOf(": ") + 2);
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
  if (ins.startsWith("Someone opens a listing")) {
    const item = quoted(p, "Item"), how = p.match(/How the asker gets it: (.*)/)?.[1] ?? "";
    if (/Asker: candidate/.test(p)) return { questions: [{ label: "Still open?", text: `Is the ${item} role still open?` }, { label: "Salary", text: "What salary is on offer?" }, { label: "Interview", text: "What's the interview process?" }] };
    return { questions: /book/.test(how) ? [{ label: "When free?", text: `When are you free for ${item}?` }, { label: "Price", text: `What's your best rate for ${item}?` }, { label: "Book", text: "Can I book a time this week?" }]
      : /visit/.test(how) ? [{ label: "Available?", text: `Is ${item} still available?` }, { label: "Price", text: `What's your best price for ${item}?` }, { label: "Visit", text: "When can I come to see it?" }]
      : [{ label: "In stock?", text: `Do you have ${item} in stock?` }, { label: "Price", text: `What's your best price for ${item}?` }, { label: "Collect", text: "Can I order now and collect today?" }] };
  }
  if (ins.startsWith("Suggest the terms the owner")) return /Owner: employer/.test(p)
    ? { terms: [{ label: "Probation", text: "The first three months are a probation period." }, { label: "Notice period", text: "One month's notice from either side after probation." }] }
    : { terms: [{ label: "Cancellation", text: "Free up to 2 hours before the booked time." }, { label: "Payment", text: "In the app, or in cash when you come in." }] };
  if (ins.startsWith("A person is publishing a listing")) return /owner is the employer/.test(p)
    ? { asks: [{ label: "Hours", question: "What are the working hours?", options: ["Full-time", "Part-time", "Shifts"] }, { label: "Where", question: "Is it remote, hybrid or on-site?", options: ["Remote", "Hybrid", "On-site"] }] }
    : { asks: [{ label: "Condition", question: "What condition is it in?", options: ["Like new", "Good", "Some wear"] },
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
