// Commerce events, copied to BigQuery for analysis and demand forecasting — only when the owner has set it up
// (BQ_DATASET, in GOOGLE_CLOUD_PROJECT); without it every call here does nothing and the forecast says so. Three kinds
// of row, none personal:
//   · requests — a request was made: its category, public area, item and how many.
//   · deals — a deal was paid (in the app or outside it): the same, plus the agreed unit price, the listed price and
//     the currency. Never a private limit.
//   · demand_misses — a buyer wanted more than a seller had: how many wanted, how many there were.
// People appear only as a keyed hash (HMAC-SHA256 with the server's secret) of the seller's and buyer's account, so
// rows from one seller can be grouped without anyone being named, and the hash can't be reversed or recomputed
// outside the server. No names, handles, request text, notes or limits ever leave.
// Rows stream with tabledata.insertAll, fire-and-forget with a timeout: a failure is a warning in the log, never a
// failed request. The forecast (AI.FORECAST, TimesFM) runs once per seller per day; the result is kept in Firestore
// so the insights card never waits on a query twice.
import { createHmac } from "node:crypto";
import { GoogleAuth } from "google-auth-library";
import type { Docs } from "../docs.ts";
import { log } from "../log.ts";
import { domain } from "../market/domains.ts";
import { currencyOf } from "../market/types.ts";
import type { Brief, Engagement, Fact } from "./model.ts";
import { buyerOf, sellerOf } from "./pay.ts";
import type { DemandMiss } from "./shop-insights.ts";

export const FORECASTS = "forecasts";
export const NOT_SET_UP = "BigQuery isn't set up yet";
const DAY = 86_400, RETRY_FAILED = 3600, TIMEOUT_MS = 5000, QUERY_MS = 20_000, MAX_CATS = 5;

/** Next 7 days of requests, per category the seller sells. `reason` says why there's nothing (in plain words). */
export interface Forecast { available: boolean; reason?: string; items: { label: string; next7: number }[] }
export interface RequestRow { at: string; category: string | null; area: string | null; item: string | null; units: number }
export interface DealRow extends RequestRow { unit_price: number; listed: number | null; currency: string; seller_hash: string; buyer_hash: string }
export interface MissRow { at: string; category: string | null; area: string | null; item: string; wanted: number; available: number; seller_hash: string }

/** A keyed hash of an account: stable per server secret, so a seller's rows group together; not reversible. */
export const hashId = (secret: string, id: string) => createHmac("sha256", secret).update(`bq:${id}`).digest("hex").slice(0, 32);
const iso = (t: number) => new Date(t * 1000).toISOString();
/** The item a title names ("Steel bottle · 500 ml" → "Steel bottle"), the same reading as shop insights. */
const itemOf = (title: string) => title.split(" · ")[0].replace(/\s+/g, " ").trim().slice(0, 60) || null;

// MARK: - Rows (pure, so tests can check exactly what would leave)

export function requestRow(b: Brief, units: number, at: number): RequestRow {
  return { at: iso(at), category: b.shared.category || b.need.category || null, area: b.shared.area ?? b.need.place?.name ?? null,
    item: itemOf(b.need.attributes?.item ?? b.shared.title ?? ""), units };
}

/** A paid deal: units and the unit price as shop insights reads them (several lines: their total over the units). */
export function dealRow(secret: string, e: Engagement, at: number): DealRow | null {
  const d = e.negotiation.deal; if (!d) return null;
  const units = d.items?.length ? d.items.reduce((n, l) => n + l.quantity, 0) : (d.terms?.quantity ?? 1) > 1 ? d.terms!.quantity! : 1;
  const each = d.items?.length ? d.items.reduce((t, l) => t + l.quantity * l.unitPrice, 0) / units : d.price;
  const seller = e[sellerOf(e)], buyer = e[buyerOf(e)];
  return { at: iso(at), category: e.offer.category, area: e.brief?.area ?? null, item: itemOf(e.offer.title), units,
    unit_price: Math.round(each * 100) / 100, listed: e.offer.price, currency: currencyOf(e),
    seller_hash: hashId(secret, seller.uid ?? seller.handle), buyer_hash: hashId(secret, buyer.uid ?? buyer.handle) };
}

export function missRow(secret: string, m: Omit<DemandMiss, "id">, category: string | null, area: string | null): MissRow {
  return { at: iso(m.at), category, area, item: itemOf(m.item) ?? "", wanted: m.wanted, available: m.available, seller_hash: hashId(secret, m.seller) };
}

// MARK: - The forecast query

/** Table names come from configuration, never from a request; checked anyway, since they can't be parameters. */
const PROJECT_ID = /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/, DATASET_ID = /^\w{1,1024}$/;

/**
 * Requests per day for one category (and area) over the last 90 days, days with none counted as 0, forecast 7 days
 * ahead by BigQuery's TimesFM model. The category and area are query parameters — never written into the SQL.
 */
export function forecastQuery(project: string, dataset: string, category: string, area: string | null) {
  if (!PROJECT_ID.test(project) || !DATASET_ID.test(dataset)) throw new Error("bad BigQuery project or dataset name");
  const query = `SELECT forecast_timestamp, forecast_value, ai_forecast_status FROM AI.FORECAST((
  SELECT day, COUNT(r.at) AS n
  FROM UNNEST(GENERATE_DATE_ARRAY(DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY), DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY))) AS day
  LEFT JOIN \`${project}.${dataset}.requests\` AS r
    ON DATE(r.at) = day AND r.category = @category AND (@area = '' OR r.area = @area)
  GROUP BY day),
  data_col => 'n', timestamp_col => 'day', horizon => 7)`;
  const param = (name: string, value: string) => ({ name, parameterType: { type: "STRING" }, parameterValue: { value } });
  return { query, useLegacySql: false, parameterMode: "NAMED", queryParameters: [param("category", category), param("area", area ?? "")] };
}

/** The 7-day total from a jobs.query response: forecasts below zero count as none. Null when the model said no. */
export function next7From(res: any): number | null {
  if (!res?.jobComplete || !Array.isArray(res.rows)) return null;
  const names: string[] = (res.schema?.fields ?? []).map((f: any) => f.name);
  const at = (row: any, name: string) => row.f?.[names.indexOf(name)]?.v;
  if (res.rows.some((r: any) => at(r, "ai_forecast_status"))) return null;
  const values = res.rows.map((r: any) => Number(at(r, "forecast_value")));
  return values.length && values.every(Number.isFinite) ? Math.round(values.reduce((t: number, v: number) => t + Math.max(0, v), 0)) : null;
}

/** "goods" → "Goods for sale", from the category list the app ships; an unknown one in plain words. */
export const categoryLabel = (c: string) => domain(c)?.label ?? c.replace(/[-_]+/g, " ").replace(/^\w/, x => x.toUpperCase());

// MARK: - The client

export interface Analytics {
  enabled: boolean;
  request(b: Brief, units: number, at: number): void;
  deal(e: Engagement, at: number): void;
  miss(m: Omit<DemandMiss, "id">, category: string | null, area: string | null): void;
  forecastNext7(category: string, area: string | null): Promise<number | null>;
  /** The seller's forecast for the insights card: kept per seller per day (a failure is retried after an hour). */
  forecastFor(db: Docs, uid: string, area: string | null, now: number): Promise<Forecast>;
}

/** One authorised call to the BigQuery REST API (replaced in tests). */
export type BigQueryCall = (path: string, body: unknown, timeoutMs: number) => Promise<any>;

function restCall(): BigQueryCall {
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/bigquery"] });
  return async (path, body, timeoutMs) => {
    const token = await auth.getAccessToken();
    const r = await fetch(`https://bigquery.googleapis.com/bigquery/v2/${path}`, { method: "POST", signal: AbortSignal.timeout(timeoutMs),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
    return r.json();
  };
}

const off: Analytics = {
  enabled: false,
  request() {}, deal() {}, miss() {},
  async forecastNext7() { return null; },
  async forecastFor() { return { available: false, reason: NOT_SET_UP, items: [] }; },
};

export function analytics(project: string | undefined, dataset: string | undefined, secret: string, call?: BigQueryCall): Analytics {
  if (!project?.trim() || !dataset?.trim()) return off;
  const p = project.trim(), ds = dataset.trim(), send = call ?? restCall();
  // Fire and forget: the user's request never waits on (or fails with) the copy.
  const insert = (table: string, row: object, insertId?: string) => {
    void send(`projects/${p}/datasets/${ds}/tables/${table}/insertAll`, { rows: [{ ...(insertId ? { insertId } : {}), json: row }] }, TIMEOUT_MS)
      .then(r => { if (r?.insertErrors?.length) log.warn("BigQuery row rejected", { table, error: JSON.stringify(r.insertErrors).slice(0, 200) }); })
      .catch(e => log.warn("BigQuery row not copied", { table, error: String(e).slice(0, 200) }));
  };
  const forecastNext7 = async (category: string, area: string | null) =>
    next7From(await send(`projects/${p}/queries`, { ...forecastQuery(p, ds, category, area), timeoutMs: QUERY_MS }, QUERY_MS + 5000));
  return {
    enabled: true,
    request(b, units, at) { insert("requests", requestRow(b, units, at), `request-${b.id}`); },
    deal(e, at) { const row = dealRow(secret, e, at); if (row) insert("deals", row, `deal-${e.id}`); },
    miss(m, category, area) { insert("demand_misses", missRow(secret, m, category, area)); },
    forecastNext7,
    async forecastFor(db, uid, area, now) {
      const facts = (await db.find("facts", [["owner", "==", uid]], 200)) as Fact[];
      const cats = [...new Set(facts.filter(f => f.tier === "public" && f.offer?.category).map(f => f.offer!.category))].sort().slice(0, MAX_CATS);
      if (!cats.length) return { available: false, reason: "List something to see a forecast", items: [] };
      const id = `${uid}:${Math.floor(now / DAY)}`, key = `${cats.join(",")}|${area ?? ""}`;
      const kept = (await db.get(FORECASTS, id)) as { key: string; at: number; forecast: Forecast } | null;
      if (kept?.key === key && (kept.forecast.available || now - kept.at < RETRY_FAILED)) return kept.forecast;
      const got = await Promise.all(cats.map(c => forecastNext7(c, area).catch(e => { log.warn("BigQuery forecast failed", { error: String(e).slice(0, 200) }); return null; })));
      const items = cats.flatMap((c, i) => (got[i] == null ? [] : [{ label: categoryLabel(c), next7: got[i]! }]));
      const forecast: Forecast = items.length ? { available: true, items } : { available: false, reason: "No forecast right now", items: [] };
      await db.set(FORECASTS, id, { id, owner: uid, key, at: now, forecast }).catch(() => {});
      return forecast;
    },
  };
}
