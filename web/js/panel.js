// What's opened beside the page — a deal, a pass, a receipt, an agent log, your agent card — in the right panel (the
// one screens use on wide windows). On a desktop it sits beside the chat; on a phone it takes the screen. One at a
// time, with a way back; Escape closes it. A view gives `render` (redrawn on every live refresh) or fixed `html`, and
// may handle clicks of its own; ordinary data-act buttons inside it work as anywhere else.
let detail = null, repaint = () => {};

export const panelDetail = () => detail;
export function openPanel(view) { detail = { title: view.title ?? "", html: view.html ?? "", render: view.render ?? null, handle: view.handle ?? null }; repaint(); }
export function clearPanel() { detail = null; }
export function closePanel() { if (!detail) return; detail = null; repaint(); }

/** Wire once: the app's paint, clicks for the open view, Escape. */
export function startPanel(paint) {
  repaint = paint;
  const panel = document.getElementById("panel");
  if (!panel) return;
  panel.addEventListener("click", async e => { if (e.target.closest('[data-act="panel-close"]')) return closePanel(); if (detail?.handle) await detail.handle(e); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && detail) closePanel(); });
}
