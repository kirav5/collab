// The side panel: what you open — a deal, a pass, a receipt, an agent log, your agent card — appears beside the main
// view on a desktop (the view narrows to make room, so nothing leaves the screen) and over it on a phone. One at a
// time; Escape or ✕ closes it. The panel keeps its own click handler, so a view can act without leaving the page.
import { esc } from "./ui.js";

let onClick = null;

export function openPanel({ title, html, kind = "", handle = null, replace = true }) {
  const app = document.getElementById("app"), panel = document.getElementById("panel");
  if (!app || !panel) return null;
  if (!replace && app.classList.contains("panel-open")) return panel.querySelector(".panel-body");
  onClick = handle;
  panel.innerHTML = `<div class="panel-head"><span class="label sq ink">${esc(title)}</span><button class="btn quiet compact panel-close" data-act="panel-close" aria-label="Close">✕</button></div><div class="panel-body ${kind}">${html}</div>`;
  panel.hidden = false;
  app.classList.add("panel-open");
  panel.scrollTop = 0;
  return panel.querySelector(".panel-body");
}

export function setPanel(html) { const b = document.querySelector("#panel .panel-body"); if (b) b.innerHTML = html; return b; }
export const panelOpen = () => !!document.getElementById("app")?.classList.contains("panel-open");

export function closePanel() {
  const app = document.getElementById("app"), panel = document.getElementById("panel");
  if (!app || !panel) return;
  app.classList.remove("panel-open");
  panel.hidden = true; panel.innerHTML = ""; onClick = null;
}

/** Wire once: clicks inside the panel go to the open view's handler; ✕ and Escape close it. */
export function startPanel() {
  const panel = document.getElementById("panel");
  if (!panel) return;
  panel.addEventListener("click", async e => {
    if (e.target.closest('[data-act="panel-close"]')) return closePanel();
    if (onClick) await onClick(e);
  });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && panelOpen()) closePanel(); });
}
