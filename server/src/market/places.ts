// The gazetteer Collab ships (GeoNames, CC BY 4.0: cities and neighbourhoods) and the same lookups: a place name as
// written → the place people mean, preferring the one near the owner, and only a big city far away ("Airport" from
// Bengaluru isn't Honolulu's).
import { readFileSync } from "node:fs";
import { distanceKm } from "./geo.ts";
import type { Place } from "./types.ts";

interface Row { name: string; lat: number; lon: number; isCity: boolean; population: number }

const ALIASES: Record<string, string> = { bangalore: "Bengaluru", bombay: "Mumbai", calcutta: "Kolkata", madras: "Chennai",
  gurgaon: "Gurugram", newdelhi: "New Delhi", poona: "Pune" };
const nameKey = (s: string) => s.toLowerCase().replace(/[^\p{L}]/gu, "");

let loaded: { byName: Map<string, Row[]>; buckets: Map<number, Row[]>; keys: string[] } | null = null;

function index() {
  if (loaded) return loaded;
  const byName = new Map<string, Row[]>(), buckets = new Map<number, Row[]>();
  const text = ["places.tsv", "places.extra.tsv"].map(f => readFileSync(new URL(`../data/${f}`, import.meta.url), "utf8")).join("\n");
  for (const line of text.split("\n")) {
    if (!line || line[0] === "#") continue;
    const f = line.split("\t");
    const lat = Number(f[1]), lon = Number(f[2]);
    if (f.length < 4 || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const r: Row = { name: f[0], lat, lon, isCity: f[3] === "c", population: Number(f[4] ?? 0) || 0 };
    const k = nameKey(r.name);
    (byName.get(k) ?? byName.set(k, []).get(k)!).push(r);
    const b = bucket(Math.floor(lat), Math.floor(lon));
    (buckets.get(b) ?? buckets.set(b, []).get(b)!).push(r);
  }
  return (loaded = { byName, buckets, keys: [...byName.keys()].sort() });
}

const bucket = (lat: number, lon: number) => (lat + 90) * 1000 + (lon < -180 ? lon + 360 : lon >= 180 ? lon - 360 : lon) + 180;
const dist = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => distanceKm(a.lat, a.lon, b.lat, b.lon);

function around(lat: number, lon: number, km: number, cities: boolean | null): [Row, number][] {
  const { buckets } = index();
  const out: [Row, number][] = [];
  const la = Math.floor(lat), lo = Math.floor(lon);
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    for (const p of buckets.get(bucket(la + i, lo + j)) ?? []) {
      if (cities !== null && p.isCity !== cities) continue;
      const d = distanceKm(lat, lon, p.lat, p.lon);
      if (d <= km) out.push([p, d]);
    }
  }
  return out;
}

function largestCity(lat: number, lon: number, km: number): Row | null {
  return around(lat, lon, km, true).sort((a, b) => b[0].population - a[0].population || a[1] - b[1])[0]?.[0] ?? null;
}

function candidates(first: string): Row[] {
  return index().byName.get(nameKey(ALIASES[nameKey(first)] ?? first)) ?? [];
}

function find(raw: string): Row | null {
  const parts = raw.split(",").map(s => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  const c = candidates(parts[0]);
  if (!c.length) return null;
  if (parts.length > 1) {
    const city = find(parts[1]);
    if (city?.isCity) {
      const best = [...c].sort((a, b) => dist(a, city) - dist(b, city))[0];
      return dist(best, city) < 40 ? best : null;
    }
  }
  const city = c.filter(p => p.isCity).sort((a, b) => b.population - a.population)[0];
  if (city && city.population >= 100_000) return city;
  const weight = (p: Row) => (p.isCity ? p.population : largestCity(p.lat, p.lon, 25)?.population ?? 0);
  return [...c].sort((a, b) => weight(b) - weight(a))[0];
}

function toPlace(r: Row): Place {
  const city = r.isCity ? null : largestCity(r.lat, r.lon, 25);
  return { name: city ? `${r.name}, ${city.name}` : r.name, lat: r.lat, lon: r.lon, isCity: r.isCity };
}

/** A place name as written → a place, preferring the one near `near` (and refusing a small place far away). */
export function resolve(phrase: string, near?: Place | null): Place | null {
  const p = phrase.trim().replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, "");
  if ([...p].length < 3) return null;
  if (near && !(near.name === "Online")) {
    const first = p.split(",")[0].trim();
    const close = candidates(first).map(r => [r, dist(r, near)] as const).sort((a, b) => a[1] - b[1])[0];
    if (close && close[1] <= 300) return toPlace(close[0]);
    const far = find(p);
    return far && far.isCity && far.population >= 100_000 ? toPlace(far) : null;
  }
  const found = find(p);
  return found ? toPlace(found) : null;
}

/** The neighbourhood around a position — coarse: the nearest named area, never the coordinates themselves. */
export function area(lat: number, lon: number): Place | null {
  const n = around(lat, lon, 6, false).sort((a, b) => a[1] - b[1])[0] ?? around(lat, lon, 30, true).sort((a, b) => a[1] - b[1])[0];
  return n ? toPlace(n[0]) : null;
}

/** Places whose name starts with what's typed, nearest first when the owner's area is known (for the area picker). */
export function suggest(q: string, near?: Place | null, limit = 8): Place[] {
  const k = nameKey(q);
  if (k.length < 2) return [];
  const { keys, byName } = index();
  let lo = 0, hi = keys.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (keys[m] < k) lo = m + 1; else hi = m; }
  const rows: Row[] = [];
  for (let i = lo; i < keys.length && keys[i].startsWith(k) && rows.length < 400; i++) rows.push(...byName.get(keys[i])!);
  const score = (r: Row) => near ? dist(r, near) : -(r.isCity ? r.population : 0);
  return rows.filter(r => r.isCity || !near || dist(r, near) < 60 || r.population > 0)
    .sort((a, b) => score(a) - score(b)).slice(0, limit).map(toPlace);
}
