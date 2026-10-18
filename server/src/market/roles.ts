// What to call each side of a deal, by category: the one who is paid (payee) and the one who pays (payer). A job's
// payee is the candidate and its payer the employer, whoever posted the listing. Kept apart from domains.json, which
// the native app ships too.

/** How an agreed deal is closed, in words for each step: the one paid marks it done, the one paying confirms. */
export interface Close {
  /** The headline once both confirmed ("Deal agreed", "Offer accepted"), and what each owner is asked before that. */
  agreed: string; confirmAsk: string;
  /** The one paid: the button, and what it records. */
  mark: string; marked: string;
  /** The one paying: what they're told, the button, and what it records. */
  markedBy: string; confirm: string; confirmed: string;
  /** "<who> confirmed it arrived as agreed" / "<who> confirmed they joined". */
  confirmedLine: string;
  /** Next steps (Requests): for the one paid, for the one paying while waiting, and once marked; and when it's done. */
  todo: string; waiting: string; confirmTodo: string; done: string;
}

/** The kind of deal, which decides how each side talks: buying a thing, booking a service, visiting before a
 *  handover (a flat, a car), or hiring. */
export type Flow = "buy" | "book" | "visit" | "hire";

export interface Roles {
  flow: Flow;
  payee: string; payees: string;
  payer: string; payers: string;
  /** What the money is called: price, salary, rent, fee, fare. */
  price: string;
  /** How the one who responds to a listing gets it, when that isn't buying, booking or visiting. */
  respond?: string;
  /** What the receipt calls the thing agreed, when it isn't an item or a service ("Role"). */
  item?: string;
  /** False when the money doesn't change hands in the app (a salary): no test payment, no pass. */
  payInApp: boolean;
  close: Close;
  /** The usual questions by role, when the category's own (domains.json: written for the provider being the one paid)
   *  don't fit both directions — a job post can come from an employer or from someone looking for work. */
  asks?: { payee: string[]; payer: string[] };
  /** What the one paid shares about themselves when they ask (a candidate's profile): tap-to-answer, shared with the
   *  other side, answered from by their agent — never a salary, a limit or contact details. */
  profile?: ProfileAsk[];
}

/** One profile question: `options` to tap (empty: the person types it). */
/** `multi`: several can be picked (skills). */
export interface ProfileAsk { label: string; question: string; options: string[]; multi?: boolean }

const HANDOVER: Close = { agreed: "Deal agreed", confirmAsk: "Confirm the deal?", confirmedLine: "confirmed it arrived as agreed", mark: "Mark delivered", marked: "Marked as delivered.", markedBy: "handed it over", confirm: "Received it ✓",
  confirmed: "Received it — all good.", todo: "Hand it over.", waiting: "Waiting for the handover.", confirmTodo: "Confirm you received it.", done: "Done — received as agreed." };
const JOINING: Close = { agreed: "Offer accepted", confirmAsk: "Accept the offer?", confirmedLine: "confirmed they joined", mark: "I've joined", marked: "Joined.", markedBy: "says they've joined", confirm: "Confirm they joined ✓",
  confirmed: "Confirmed they joined.", todo: "Mark when you've joined.", waiting: "Waiting for them to join.", confirmTodo: "Confirm they joined.", done: "Done — joined." };

type Extra = { respond?: string; item?: string; payInApp?: boolean; close?: Close; asks?: Roles["asks"]; profile?: ProfileAsk[] };
const r = (flow: Flow, payee: string, payer: string, price: string, extra: Extra = {}): Roles =>
  ({ flow, payee, payees: `${payee}s`, payer, payers: `${payer}s`, price, ...(extra.respond ? { respond: extra.respond } : {}), ...(extra.item ? { item: extra.item } : {}),
    payInApp: extra.payInApp ?? true, close: extra.close ?? HANDOVER, ...(extra.asks ? { asks: extra.asks } : {}), ...(extra.profile ? { profile: extra.profile } : {}) });

const ROLES: Record<string, Roles> = {
  "property-sale": r("visit", "seller", "buyer", "price"),
  "property-rent": r("visit", "landlord", "tenant", "rent"),
  wholesale: r("buy", "supplier", "buyer", "price"),
  freight: r("book", "transporter", "shipper", "rate"),
  services: r("book", "professional", "client", "fee"),
  "equipment-rental": r("book", "owner", "renter", "rent"),
  "commercial-lease": r("visit", "landlord", "tenant", "rent"),
  manufacturing: r("buy", "manufacturer", "client", "price"),
  rides: r("book", "driver", "rider", "fare"),
  food: r("buy", "cook", "customer", "price"),
  lessons: r("book", "teacher", "student", "fee"),
  tasks: r("book", "helper", "client", "fee"),
  goods: r("buy", "seller", "buyer", "price"),
  vehicles: r("visit", "seller", "buyer", "price"),
  stays: r("book", "host", "guest", "rate"),
  // A salary is paid by the employer as agreed, outside Collab: the deal closes on the offer accepted, then joining.
  jobs: r("hire", "candidate", "employer", "salary", { respond: "apply and interview", item: "Role", payInApp: false, close: JOINING, asks: {
    payee: ["Is the position still open, and what's the interview process?", "What are the working hours, and is it remote, hybrid or on-site?"],
    payer: ["How many years of relevant experience do you have, and what's your notice period?", "When could you start?"] },
    // What an employer screens for, so the candidate's agent can answer it without asking them.
    profile: [
      { label: "Experience", question: "How many years of relevant experience do you have?", options: ["Fresher", "1–2 years", "3–5 years", "5+ years"] },
      { label: "Skills", question: "What are your main skills?", options: [], multi: true },
      { label: "Notice period", question: "When could you join?", options: ["Right away", "Within 15 days", "Within 30 days", "In 60+ days"] },
      { label: "Work mode", question: "Remote, hybrid or on-site?", options: ["Remote", "Hybrid", "On-site", "Any"] },
    ] }),
  events: r("book", "organiser", "customer", "price"),
  beauty: r("book", "stylist", "client", "price"),
  pets: r("book", "pet carer", "pet owner", "fee"),
};

const GENERAL = r("buy", "provider", "customer", "price");

export const rolesFor = (category: string | null | undefined): Roles => ROLES[category ?? ""] ?? GENERAL;

/** The whole table, for the app (it names each side of a conversation from the category and who is paid). */
export const roleTable = () => ({ byCategory: ROLES, general: GENERAL });

/**
 * A price limit pointed the way its side wants: the one paid opens at or above their limit (the least they'd take),
 * the one paying at or below it (the most they'd pay). A limit sent the other way round is mirrored around the limit,
 * so "open at 0.9× my number" from a payer's form becomes "open at 1.1×" for a payee.
 */
export function orientMandate<M extends { price: { opening: number; limit: number } }>(m: M, paid: boolean): M {
  const { opening, limit } = m.price;
  if (paid ? opening >= limit : opening <= limit) return m;
  return { ...m, price: { opening: Math.max(1, 2 * limit - opening), limit } };
}

/** A listing's owner and the people who respond to it: an employer's job post is answered by candidates. */
export function listingRoles(category: string | null | undefined, ownerPays: boolean) {
  const x = rolesFor(category);
  return ownerPays
    ? { owner: x.payer, responder: x.payee, responders: x.payees, price: x.price, respond: x.respond }
    : { owner: x.payee, responder: x.payer, responders: x.payers, price: x.price, respond: x.respond };
}

// Explicit phrases only; the paying ones are checked first ("offering a job" pays, "offering haircuts" is paid).
const WRITER_PAYS = /\b(?:we(?:'re| are)? hiring|hiring|looking to hire|want(?:ing)? to hire|need to hire|recruiting|vacanc(?:y|ies)|job openings?|offering (?:a |an )?(?:job|role|position|internship)|want(?:ing)? to buy|looking to buy|i(?:'ll| will) pay|we(?:'ll| will) pay)\b/i;
const WRITER_PAID = /\b(?:selling|sell my|for sale|rent(?:ing)? out|i teach|i offer|looking for (?:a )?(?:job|work)|seeking (?:a )?(?:job|work|role|position)|available for (?:work|hire)|open to work|hire me)\b/i;

/** Who pays, when the writer says it in so many words: "writer" (we're hiring), "other" (selling my bike), else null. */
export function payerCue(text: string): "writer" | "other" | null {
  return WRITER_PAYS.test(text) ? "writer" : WRITER_PAID.test(text) ? "other" : null;
}

// MARK: - How each side talks

/** One side's lines in a negotiation: "{amount}" is the offer, "{name}" the owner's first name, "{price}" what the
 *  money is called. No "final offer" line: the last round is the limit itself, and saying so would give it away. */
export interface Lines { open: string; counter: string; accept: string }

const VOICES: Record<Flow, { payee: Lines; payer: Lines }> = {
  buy: { payee: { open: "We're asking {amount}.", counter: "We can come down to {amount}.", accept: "{amount} works for us." },
    payer: { open: "Would you take {amount}?", counter: "Could you do {amount}?", accept: "{amount} works for us." } },
  book: { payee: { open: "Our {price} is {amount}.", counter: "We can do {amount}.", accept: "{amount} works for us." },
    payer: { open: "Could you do {amount}?", counter: "How about {amount}?", accept: "{amount} works for us." } },
  visit: { payee: { open: "The {price} is {amount}.", counter: "We could come down to {amount}.", accept: "{amount} works for us." },
    payer: { open: "Would you consider {amount}?", counter: "Could you do {amount}?", accept: "{amount} works for us." } },
  hire: { payee: { open: "Thanks — {name} is looking for {amount}.", counter: "{name} could do {amount}.", accept: "{name} is happy with {amount}." },
    payer: { open: "We can offer {amount} for this role.", counter: "We could raise that to {amount}.", accept: "{amount} works for us — we'll confirm the offer." } },
};

/** How one side of a conversation talks: its role, the other side's, and its lines. `name`: the owner's first name. */
export interface Voice extends Lines { me: string; them: string; price: string; name: string; flow: Flow }

export function voiceFor(category: string | null | undefined, paid: boolean, name: string): Voice {
  const x = rolesFor(category);
  return { ...VOICES[x.flow][paid ? "payee" : "payer"], me: paid ? x.payee : x.payer, them: paid ? x.payer : x.payee, price: x.price, name: shortName(name), flow: x.flow };
}

/** A line with its blanks filled. */
export const fill = (line: string, v: Pick<Voice, "name" | "price">, amount: string) =>
  line.replace(/\{amount\}/g, amount).replace(/\{name\}/g, v.name).replace(/\{price\}/g, v.price);

/** How an owner is named in their agent's lines: a person by first name ("Dr. Mehta" keeps the title), a business in
 *  full. web/js/ui.js shortName follows the same rule, so the app's labels match. No name at all: "my owner". */
export function shortName(name: string): string {
  const trimmed = (name ?? "").trim(), words = trimmed.split(/\s+/).filter(Boolean);
  if (!words.length) return "my owner";
  const business = words.length >= 3 || /\b(store|stores|shop|mart|traders?|enterprises?|academy|studio|services?|centre|center|kitchen|cafe|café|bakery|clinic|salon|agency|rentals?|motors|pvt|ltd|llp|co\.?|tiffins?|foods?|tech|technologies|labs?|solutions|systems|software|digital|media|consulting|infotech)\b/i.test(trimmed);
  if (business) return trimmed;
  return /^(mr|mrs|ms|miss|dr|prof|shri|smt|sri)\.?$/i.test(words[0]) && words[1] ? `${words[0]} ${words[1]}` : words[0];
}

/** The usual questions one side asks the other, picked by whether the asker is the one paid. A category whose own
 *  questions don't fit both directions (a job) names them by role. */
export function usualAsks(category: string | null | undefined, side: "provider" | "requester", providerPaid: boolean, d: { sellerAsks: string[]; buyerAsks: string[] } | null): string[] {
  // sellerAsks are the paid side's questions and buyerAsks the paying side's — whichever side posted the listing (a
  // "looking to rent" post is answered by a landlord, who asks the landlord's questions).
  const asks = rolesFor(category).asks, askerPaid = side === "provider" ? providerPaid : !providerPaid;
  if (!asks) return (askerPaid ? d?.sellerAsks : d?.buyerAsks) ?? [];
  return askerPaid ? asks.payee : asks.payer;
}

/**
 * The requester's first line to the provider's agent: an application, an enquiry, or an answer to a wanted post.
 * `title`: the listing's own title, as its owner's words in their own case ("Junior Developer", "2BHK for rent in
 * Indiranagar"), or null when the conversation isn't about a listing; `summary`: the shared brief, which never holds a
 * budget or a limit; `about`: what the requester shared about themselves — an application leads with it.
 */
export function introFor(category: string | null | undefined, requesterPaid: boolean, name: string, title: string | null, summary: string,
  about: { label: string; value: string }[] = []): string {
  const x = rolesFor(category), who = shortName(name);
  const t = title?.trim().replace(/[\s:;,.–—-]+$/, "") || null;
  let lead: string;
  if (x.flow === "hire") {
    // "Delivery Executive Job" → "the Delivery Executive role", never "…job role".
    let role = t ?? "";
    while (/\s*\b(job|jobs|role|roles|position|positions|vacancy|vacancies|opening|openings|offer|hiring)$/i.test(role)) role = role.replace(/\s*\b(job|jobs|role|roles|position|positions|vacancy|vacancies|opening|openings|offer|hiring)$/i, "").trim();
    lead = requesterPaid ? `Hello — ${who} would like to apply for ${role ? `the ${role} role` : "this role"}.` : `Hello — ${who} would like to talk to you about a role.`;
  } else if (!t) lead = `Hi — ${who} has a request for you.`;
  else lead = requesterPaid ? `Hi — ${who} saw your post “${t}” and can help.` : `Hi — ${who} is interested in “${t}”.`;
  const more = (about.length ? aboutLine(about) : summary).trim().replace(/\s+/g, " ").slice(0, 240);
  return more ? `${lead} ${/[.!?]$/.test(more) ? more : `${more}.`}` : lead;
}

/** What someone shares about themselves, kept to plain job-relevant facts: no contact details, no amounts or salary
 *  (their minimum is their private limit), nothing long. */
export function aboutFrom(raw: unknown, labels: string[]): { label: string; value: string }[] {
  if (!Array.isArray(raw)) return [];
  const out: { label: string; value: string }[] = [];
  for (const a of raw.slice(0, 8)) {
    const label = typeof a?.label === "string" ? a.label.trim().slice(0, 30) : "", value = typeof a?.value === "string" ? a.value.trim().replace(/\s+/g, " ").slice(0, 120) : "";
    if (!label || !value || !labels.includes(label) || out.some(x => x.label === label)) continue;
    if (/[\w.+-]+@[\w-]+\.[\w.]+|\+?\d[\d\s-]{8,}\d|https?:/i.test(value)) continue;
    if (/₹|\b(rs\.?|inr|lakhs?|lpa|ctc|salary|stipend|per month|a month|\/month|k\/m)\b/i.test(value)) continue;
    out.push({ label, value });
  }
  return out;
}

/** "Experience: 1–2 years · Skills: React, Node · …" */
export const aboutLine = (about: { label: string; value: string }[]) => about.map(a => `${a.label}: ${a.value}`).join(" · ");
