// Geohash (the area tag NIP-99 listings use, `g`) and distances — as in Collab's Geo.swift.
const ALPHABET = "0123456789bcdefghjkmnpqrstuvwxyz";

export function encode(lat: number, lon: number, precision: number): string {
  let la: [number, number] = [-90, 90], lo: [number, number] = [-180, 180];
  let hash = "", bits = 0, bit = 0, even = true;
  while (hash.length < precision) {
    if (even) {
      const mid = (lo[0] + lo[1]) / 2;
      if (lon >= mid) { bits = (bits << 1) | 1; lo[0] = mid; } else { bits <<= 1; lo[1] = mid; }
    } else {
      const mid = (la[0] + la[1]) / 2;
      if (lat >= mid) { bits = (bits << 1) | 1; la[0] = mid; } else { bits <<= 1; la[1] = mid; }
    }
    even = !even;
    if (++bit === 5) { hash += ALPHABET[bits]; bits = 0; bit = 0; }
  }
  return hash;
}

/** Every cell of `precision` touching a circle of `radiusKm` around a point (sampled on a grid finer than a cell). */
export function cover(lat: number, lon: number, radiusKm: number, precision: number): string[] {
  const cellKm = precision <= 4 ? 39 : precision === 5 ? 4.9 : 1.2;
  const step = Math.max(0.5, cellKm / 2);
  const n = Math.ceil(radiusKm / step);
  const out = new Set<string>();
  for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) {
    const dy = i * step, dx = j * step;
    if (Math.hypot(dx, dy) > radiusKm + step) continue;
    out.add(encode(lat + dy / 111, lon + dx / (111 * Math.max(0.1, Math.cos(lat * Math.PI / 180))), precision));
  }
  return [...out].sort();
}

export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p = Math.PI / 180;
  const h = Math.sin((lat2 - lat1) * p / 2) ** 2 + Math.cos(lat1 * p) * Math.cos(lat2 * p) * Math.sin((lon2 - lon1) * p / 2) ** 2;
  return 12_742 * Math.asin(Math.min(1, Math.sqrt(h)));
}
