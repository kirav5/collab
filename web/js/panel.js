// What's opened beside the page — a deal, a pass, a receipt, an agent log, your agent card — in the right panel (the
// one screens use on wide windows). On a desktop it sits beside the chat; on a phone it takes the screen. One at a
// time, with a way back; Escape closes it. A view gives `render` (redrawn on every live refresh) or fixed `html`, and
// may handle clicks of its own; ordinary data-act buttons inside it work as anywhere else.
let detail = null, repaint = () => {}, opener = null;

export const panelDetail = () => detail;
// Focus moves into the panel (on a phone it hides what opened it) and goes back to what opened it on close — found
// again by what it is, since a repaint replaces the button itself.
export function openPanel(view) {
  const f = document.activeElement;
  if (!detail) opener = f?.dataset?.act ? `[data-act="${CSS.escape(f.dataset.act)}"]${f.dataset.id ? `[data-id="${CSS.escape(f.dataset.id)}"]` : ""}` : null;
  detail = { title: view.title ?? "", html: view.html ?? "", render: view.render ?? null, handle: view.handle ?? null };
  repaint();
  requestAnimationFrame(() => document.querySelector('#panel-title [data-act="panel-close"]')?.focus());
}
export function clearPanel() { detail = null; opener = null; }
export function closePanel() {
  if (!detail) return;
  const back = opener; opener = null; detail = null; repaint();
  // The page behind is redrawn after this: focus goes back once the button is there again, unless it went elsewhere.
  const to = () => { if (back && document.activeElement === document.body) document.querySelector(back)?.focus({ preventScroll: true }); };
  for (const ms of [0, 300, 1000]) setTimeout(to, ms);
}

/** Wire once: the app's paint, clicks for the open view, Escape. */
export function startPanel(paint) {
  repaint = paint;
  const panel = document.getElementById("panel");
  if (!panel) return;
  panel.addEventListener("click", async e => { if (e.target.closest('[data-act="panel-close"]')) return closePanel(); if (detail?.handle) await detail.handle(e); });
  // Not an Escape meant for a dialog or the open menu (they close first), nor one that would lose what's typed here.
  document.addEventListener("keydown", e => {
    if (e.key !== "Escape" || !detail || e.defaultPrevented || document.querySelector("dialog[open]") || document.getElementById("app")?.classList.contains("nav-open")) return;
    if (panel.contains(e.target) && /INPUT|TEXTAREA/.test(e.target.tagName) && e.target.value) return;
    closePanel();
  });
}
