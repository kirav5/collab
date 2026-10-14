// What the server holds. Every tier is stored here under the owner's uid; the tiers differ in who may be told, not
// where they live. Private facts sit in Firestore like the rest, but the policy gate never returns them to anyone —
// no rule can name them, no engagement can draw on them. Protected facts go to the people rules name; Public facts
// are discoverable. The server also holds the conversations between agents.
import type { DemandFilter, Mandate, Need, Offer, Proposal } from "../market/types.ts";

export type Tier = "private" | "protected" | "public";
export type Side = "requester" | "provider";

export interface Profile {
  uid: string;
  handle: string;
  name: string;
  bio: string;
  /** A public area (neighbourhood centre), never a home. */
  area: { name: string; lat: number; lon: number; isCity: boolean } | null;
  createdAt: number;
  /** Seeded demo person: their "device" is simulated on the server (labelled in the app). */
  demo?: boolean;
  /** "Pause everything": the cloud agent answers nobody. */
  paused?: boolean;
}

/** A fact of any tier. Private: owner only, never shared. Protected: who a rule names. Public: anyone. */
export interface Fact {
  id: string;
  owner: string;
  text: string;
  tier: Tier;
  /** What a rule must name to see a Protected fact ("availability", "work"). */
  topics: string[];
  /** Read from a Public fact that offers something (a lesson, a flat, a ride): what, price, where. */
  offer: Offer | null;
  /** Search by meaning (Public only). */
  embedding?: number[];
  /** "chat": remembered from the owner's own chat (a question and the answer they got) — always Private. */
  source?: "chat";
  createdAt: number;
  updatedAt: number;
}

export type Shape = "yesNo" | "oneLine" | "summary" | "full";

/** Who may see which Protected topics, how much of it, and whether the owner checks first (Collab's grant). */
export interface Rule {
  id: string;
  owner: string;
  /** A person (uid) or "anyone" who contacts the owner's agent. */
  audience: string;
  audienceName: string;
  topics: string[];
  shape: Shape;
  approval: "auto" | "review";
  expires: number | null;
  createdAt: number;
  revoked?: boolean;
}

export interface Contact { owner: string; uid: string; handle: string; name: string; addedAt: number }

/** What a requester's agent tells providers: no exact budget, no coordinates, nothing private. */
export interface SharedBrief {
  title: string;
  summary: string;
  category: string;
  mode: string | null;
  area: string | null;
  requirements: { label: string; value: string; strength: "required" | "preferred" }[];
  /** A rounded band ("up to ₹40,000/month"), never the exact limit. */
  budget: string | null;
  questions: string[];
}

export interface Brief {
  id: string;
  owner: string;
  shared: SharedBrief;
  /** For matching only: the request's filters and area, with the budget as the band (not the exact limit). */
  need: Need;
  createdAt: number;
}

export interface QA {
  id: string;
  /** Who asked. */
  from: Side;
  question: string;
  answer?: string;
  /** Where the answer came from: the brief, a Public or Protected fact, or the owner. */
  source?: "brief" | "public" | "protected" | "owner" | "listing";
  status: "open" | "answered" | "pending" | "declined";
  /** The asker's judgement of the answer (requester's must-asks). */
  verdict?: "met" | "unmet" | "unclear";
  required?: boolean;
}

export interface Event { at: number; who: "requester_agent" | "provider_agent" | "requester" | "provider" | "system"; text: string; by?: "gemini" | "rules" | "owner" | "device" }

export interface Engagement {
  id: string;
  /** The A2A task between the two agents. */
  taskId: string | null;
  contextId: string | null;
  briefId: string | null;
  requester: { uid: string | null; handle: string; name: string };
  provider: { uid: string; handle: string; name: string };
  participants: string[];
  title: string;
  brief: SharedBrief;
  /** The provider's Public offering this started from. */
  offer: { factId: string | null; title: string; price: number | null; unit: string | null; category: string | null } ;
  phase: "asking" | "negotiating" | "deal" | "agreed" | "declined" | "closed";
  /** What each side's owner is being asked (both can be waiting at once). */
  waiting: Record<Side, { kind: "answer" | "move" | "confirm" | "approve"; inbox: string[]; text: string } | null>;
  qa: QA[];
  /** The provider asked its questions already (requirement gathering happens once). */
  gathered: boolean;
  negotiation: { requester: Proposal[]; provider: Proposal[]; deal: Proposal | null; dealBy: Side | null;
    confirmed: { requester: boolean; provider: boolean };
    /** Who confirmed: the owner on their device, or their standing mandate inside its limit. */
    confirmedBy?: Partial<Record<Side, "owner" | "mandate">> };
  events: Event[];
  /** When both owners confirmed (for the receipt). */
  agreedAt?: number;
  /** The anonymised deal record is written (once) to `deals`. */
  dealRecorded?: boolean;
  /** What each side later said became of the deal (a completed payment says "happened" for both). */
  outcome?: Partial<Record<Side, "happened" | "fell_through">>;
  /** Which side sells. Listings: the provider. A deal offered in a direct chat: whoever said they'd sell. */
  seller?: Side;
  /** What happened after the deal, separate from payment: handed over / delivered, then accepted or disputed by the
   *  buyer. Payment alone never marks a deal fulfilled. */
  fulfilment?: { state: "not_started" | "delivered" | "accepted" | "disputed" | "cancelled"; deliveredAt?: number; acceptedAt?: number; note?: string };
  /** AP2: the cart the seller's agent signed, and the buyer's payment against it. */
  payment?: import("./pay.ts").Payment;
  /** The requester's next turn, when a run stopped before sending it (the next run sends it). */
  outbox?: unknown;
  createdAt: number;
  updatedAt: number;
}

/** Work only the owner's device can do: answer from private context (with the owner's OK), make a move with a
 *  private limit, approve a Protected answer, confirm a deal. */
export interface InboxItem {
  id: string;
  owner: string;
  engagementId: string;
  side: Side;
  kind: "answer" | "move" | "confirm" | "approve";
  /** answer/approve: the question; approve: the drafted answer and the fact it came from. */
  qaId?: string;
  question?: string;
  draft?: string;
  /** move: the listed price the negotiation is about. */
  listPrice?: number;
  /** move: what similar deals closed at (market data, shown to the owner). */
  hint?: string;
  title: string;
  /** "working": claimed by one device while it's being resolved. */
  status: "open" | "working" | "done";
  createdAt: number;
}

/** A limit the owner set, stored with their account so every device of theirs sees the same one. */
export interface DelegatedLimit {
  key: string; owner: string; mandate: Mandate;
  /** "negotiate" (default): agent moves inside the limit, owner confirms. "close": the delegation is the confirmation.
      "ask": stored only so the owner's devices share it — every move still waits on the owner. */
  autonomy?: "negotiate" | "close" | "ask";
  expires?: number | null;
  createdAt?: number;
}

export interface Audit { id: string; owner: string; at: number; to: string; question: string; answer: string; tier: "public" | "protected"; rule: string | null }

export type { DemandFilter, Need, Offer, Proposal };
