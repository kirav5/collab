// Live state: the owner's conversations between agents and what their device is being asked. Firestore pushes
// changes when Firebase is set up; otherwise this checks every few seconds. New requests and new "needs you" items
// raise a notification.
import { api, session } from "./api.js";
import { toast } from "./ui.js";

export const live = { engagements: new Map(), inbox: [], alerts: [], watches: [], listeners: new Set(), started: false };
const seen = { engagements: new Set(), inbox: new Set(), alerts: new Set() };
let first = true;

export const onChange = fn => { live.listeners.add(fn); return () => live.listeners.delete(fn); };
const emit = () => { for (const fn of live.listeners) fn(); };

function notify(title, body, open) {
  toast(`${title} — ${body}`, open);
  try {
    if (document.hidden && "Notification" in window && Notification.permission === "granted") new Notification(title, { body, tag: title + body });
  } catch { /* not available */ }
}

function setEngagements(list, openChat) {
  for (const e of list) {
    const prev = live.engagements.get(e.id);
    live.engagements.set(e.id, e);
    if (!first && !seen.engagements.has(e.id) && e.provider.uid === session.uid) notify("New request", `${e.requester.name}'s agent: ${e.title}`, () => openChat("requests", e.id));
    if (!first && prev && prev.phase !== e.phase && e.phase === "agreed") notify("Deal agreed", e.title, () => openChat("requests", e.id));
    seen.engagements.add(e.id);
  }
  emit();
}

function setInbox(items, openChat) {
  live.inbox = items.sort((a, b) => b.createdAt - a.createdAt);
  for (const i of items) {
    if (!first && !seen.inbox.has(i.id) && i.kind !== "move") notify("Your agent needs you", i.question ?? (i.kind === "confirm" ? `Confirm the deal: ${i.title}` : i.title), () => openChat("requests", i.engagementId));
    seen.inbox.add(i.id);
  }
  emit();
}

/** What scheduled agents found: someone new who fits a watched request. */
function setAlerts(alerts, watches, openChat) {
  live.alerts = alerts;
  live.watches = watches;
  for (const a of alerts) {
    if (!first && !seen.alerts.has(a.id)) notify(`New match · ${a.title}`, a.text, () => openChat("requests"));
    seen.alerts.add(a.id);
  }
  emit();
}

export async function refresh(openChat) {
  const [es, inbox, alerts, watches] = await Promise.all([api("/api/engagements").catch(() => null), api("/api/inbox").catch(() => null),
    api("/api/alerts").catch(() => null), api("/api/watches").catch(() => null)]);
  if (es) setEngagements(es, openChat);
  if (inbox) setInbox(inbox, openChat);
  if (alerts && watches) setAlerts(alerts, watches, openChat);
  first = false;
}

let opener = () => {};
/** Check now (after this device changed something), instead of at the next tick. */
export const poke = () => refresh(opener);

export function start(openChat) {
  if (live.started) return;
  live.started = true;
  opener = openChat;
  refresh(openChat);
  if (session.fs) {
    session.fs.engagements(list => setEngagements(list, openChat));
    // Demo people's devices are simulated on the server, so their items come through the API: checked less often.
    session.fs.inbox(() => refresh(openChat));
    setInterval(() => refresh(openChat), 12_000);
  } else {
    setInterval(() => refresh(openChat), 3_000);
  }
}

export const needsYou = () => [...live.inbox.filter(i => i.kind !== "move" || i.question), ...live.alerts];
