// Maps on community posts: a trip drawn as the road route between its two areas (with distance and drive time), an
// event or group as a pin. Leaflet and OpenStreetMap tiles load only when a map is on screen; routes come from the
// public OSRM router and are kept for the session. Only area centres are sent — never anyone's own location.
const LEAFLET = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min";
const SRI = { js: "sha512-puJW3E/qXDqYp9IfhAI54BJEaWIfloJ7JWs7OeD5i6ruC9JZL1gERT1wjtwXFlh7CjE7ZJ+/vcRZRkIYIb6p4g==", css: "sha512-h9FcoyWjHcOcmEVkxOfTLnmZFWIH0iZhZT1H2TbOq55xssQGEJHEaIm+PgoUaZbRvQTNTluNOEfb1ZRy6D3BOw==" };
let leaflet = null;
const routes = new Map();

function load() {
  if (leaflet) return leaflet;
  leaflet = new Promise((ok, fail) => {
    const css = Object.assign(document.createElement("link"), { rel: "stylesheet", href: `${LEAFLET}.css`, integrity: SRI.css, crossOrigin: "anonymous" });
    const js = Object.assign(document.createElement("script"), { src: `${LEAFLET}.js`, integrity: SRI.js, crossOrigin: "anonymous", onload: () => ok(window.L), onerror: () => { leaflet = null; fail(new Error("map unavailable")); } });
    document.head.append(css, js);
  });
  return leaflet;
}

/** The road route between two points: its line, km and minutes (a straight line, roughly, when the router can't be reached). */
export function route(a, b) {
  const k = `${a.join()};${b.join()}`;
  if (!routes.has(k)) routes.set(k, fetch(`https://router.project-osrm.org/route/v1/driving/${a[1]},${a[0]};${b[1]},${b[0]}?overview=simplified&geometries=geojson`)
    .then(r => (r.ok ? r.json() : Promise.reject())).then(j => {
      const r = j.routes?.[0];
      if (!r) throw new Error("no route");
      return { line: r.geometry.coordinates.map(([lon, lat]) => [lat, lon]), km: r.distance / 1000, min: r.duration / 60, road: true };
    })
    .catch(() => { const km = straight(a, b); return { line: [a, b], km: km * 1.3, min: (km * 1.3) / 22 * 60, road: false }; }));
  return routes.get(k);
}

function straight(a, b) {
  const r = d => (d * Math.PI) / 180, dLat = r(b[0] - a[0]), dLon = r(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

const pt = s => (s ? s.split(",").map(Number) : null);
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

/** Draw every map placeholder under `root` (".trip-map" with data-from, and data-to for a trip). Safe to call after each paint. */
export async function drawTrips(root) {
  const boxes = [...root.querySelectorAll(".trip-map:not([data-drawn])")];
  if (!boxes.length) return;
  let L;
  try { L = await load(); } catch { boxes.forEach(b => b.classList.add("off")); return; }
  for (const box of boxes) {
    if (!box.isConnected || box.dataset.drawn) continue;
    box.dataset.drawn = "1";
    const a = pt(box.dataset.from), b = pt(box.dataset.to);
    const map = L.map(box, { zoomControl: false, attributionControl: true, dragging: !matchMedia("(pointer: coarse)").matches, scrollWheelZoom: false, tap: false });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, attribution: "© OpenStreetMap" }).addTo(map);
    const dot = (p, color) => L.circleMarker(p, { radius: 7, color: css("--surface") || "#fff", weight: 2, fillColor: color, fillOpacity: 1 }).addTo(map);
    if (!b) { dot(a, css("--accent")); map.setView(a, 14); continue; }
    map.fitBounds([a, b], { padding: [24, 24] });
    const r = await route(a, b);
    if (!box.isConnected) continue;
    L.polyline(r.line, { color: css("--talk") || "#06c", weight: 4, opacity: 0.9, dashArray: r.road ? null : "6 6" }).addTo(map);
    L.circleMarker(a, { radius: 7, color: css("--talk"), weight: 3, fillColor: css("--surface") || "#fff", fillOpacity: 1 }).addTo(map); dot(b, css("--accent"));
    map.fitBounds(L.latLngBounds(r.line), { padding: [24, 24] });
    const eta = box.closest("[data-post]")?.querySelector(".trip-eta");
    if (eta) eta.textContent = `${r.road ? "" : "about "}${r.km < 10 ? r.km.toFixed(1) : Math.round(r.km)} km · ${r.min < 60 ? `${Math.round(r.min)} min` : `${Math.floor(r.min / 60)} h ${Math.round(r.min % 60)} min`} by road${r.road ? "" : " (estimate)"}`;
  }
}
