// Live state: the owner's conversations between agents and what their device is being asked. Firestore pushes
// changes when Firebase is set up; otherwise this checks every few seconds. New requests and new "needs you" items
// raise a notification.
import { api, session } from "./api.js";
import { notice } from "./ui.js";

export const live = { engagements: new Map(), inbox: [], alerts: [], watches: [], listeners: new Set(), started: false };
const seen = { engagements: new Set(), inbox: new Set(), alerts: new Set() };
let first = true;

export const onChange = fn => { live.listeners.add(fn); return () => live.listeners.delete(fn); };
const emit = () => { for (const fn of live.listeners) fn(); };

/** Something happened while the app is open: a notice in the app, and the system's own when the tab is hidden. */
function notify(title, body, open, kind = "attention") {
  notice({ title, body, kind, label: { attention: "Needs you", deal: "Deal", success: "Payment", info: "New match" }[kind], action: "Open", onClick: open });
  try {
    // With push on, the server's notification already arrives — no second one from the page.
    if (document.hidden && !session.pushOn && "Notification" in window && Notification.permission === "granted") {
      const n = new Notification(title, { body, tag: title + body, icon: "/icon-192.png", badge: "/badge-96.png" });
      n.onclick = () => { window.focus(); n.close(); open?.(); };
    }
  } catch { /* not available */ }
}

// Deals agreed before AP2 carts existed: ask once for the seller's agent to issue one.
const carts = new Set();
function setEngagements(list, openChat, quiet = false) {
  for (const e of list) {
    if (e.phase === "agreed" && !e.payment && !carts.has(e.id)) { carts.add(e.id); api(`/api/engagements/${e.id}/cart`, {}).then(x => { live.engagements.set(x.id, x); emit(); }).catch(() => {}); }
    const prev = live.engagements.get(e.id);
    live.engagements.set(e.id, e);
    if (!first && !seen.engagements.has(e.id) && e.provider.uid === session.uid) notify(`${e.requester.name}'s agent wrote`, e.title, () => openChat("engagement", e.id), "attention");
    if (!first && prev && prev.phase !== e.phase && e.phase === "agreed") notify("Deal agreed", e.title, () => openChat("engagement", e.id), "deal");
    if (!first && prev && prev.payment?.status !== "paid" && e.payment?.status === "paid" && e.payment.by !== (e.requester.uid === session.uid ? "requester" : "provider")) notify("Payment received", e.title, () => openChat("engagement", e.id), "success");
    seen.engagements.add(e.id);
  }
  if (!quiet) emit();
}

function setInbox(items, openChat) {
  live.inbox = items.sort((a, b) => b.createdAt - a.createdAt);
  for (const i of items) {
    if (!first && !seen.inbox.has(i.id) && i.kind !== "move") notify(i.question ?? (i.kind === "confirm" ? "Confirm the deal" : i.title), i.question ? "Their agent asks — answer once, and your agent remembers it" : i.kind === "confirm" ? i.title : "", () => openChat("engagement", i.engagementId));
    seen.inbox.add(i.id);
  }
}

/** What scheduled agents found: someone new who fits a watched request. */
function setAlerts(alerts, watches, openChat) {
  live.alerts = alerts;
  live.watches = watches;
  for (const a of alerts) {
    if (!first && !seen.alerts.has(a.id)) notify(`New match · ${a.title}`, a.text, () => openChat("requests"), "info");
    seen.alerts.add(a.id);
  }
}

export async function refresh(openChat) {
  const [es, inbox, alerts, watches] = await Promise.all([api("/api/engagements").catch(() => null), api("/api/inbox").catch(() => null),
    api("/api/alerts").catch(() => null), api("/api/watches").catch(() => null)]);
  if (es) setEngagements(es, openChat, true);
  if (inbox) setInbox(inbox, openChat);
  if (alerts && watches) setAlerts(alerts, watches, openChat);
  first = false;
  // One repaint for the whole check, not one per list.
  emit();
}

let opener = () => {};
/** Check now (after this device changed something), instead of at the next tick. */
export const poke = () => refresh(opener);

export function start(openChat) {
  if (live.started) return;
  live.started = true;
  opener = openChat;
  refresh(openChat);
  // Polls until Firestore's live listeners are attached, then only as a backstop.
  let poll = setInterval(() => refresh(openChat), 3_000);
  session.fsReady?.then(fs => {
    if (!fs) return;
    clearInterval(poll);
    fs.engagements(list => setEngagements(list, openChat));
    // Demo people's devices are simulated on the server, so their items come through the API: checked less often.
    // The listener's first snapshot is what refresh() above already loaded.
    let first = true;
    fs.inbox(() => { if (first) { first = false; return; } refresh(openChat); });
    // With live listeners the poll is a backstop (alerts, watches, demo devices): once a minute, and only while the
    // tab is visible — 10,000 open apps must not poll four endpoints every few seconds.
    poll = setInterval(() => { if (!document.hidden) refresh(openChat); }, 60_000);
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(openChat); });
}

export const needsYou = () => [...live.inbox.filter(i => i.kind !== "move" || i.question), ...live.alerts];
/** How many things wait on you, counted the same everywhere: conversations with a decision for you, plus new matches. */
export const needsYouCount = () => new Set(live.inbox.filter(i => i.kind !== "move" || i.question).map(i => i.engagementId)).size + live.alerts.length;
