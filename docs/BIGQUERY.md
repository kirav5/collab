# BigQuery: commerce events and the demand forecast

Collab can copy what happens in the market — requests, paid deals, and demand a seller couldn't meet — to BigQuery,
and forecast next week's requests per category with BigQuery AI (`AI.FORECAST`, the TimesFM model). It is off until
the owner sets it up: without `BQ_DATASET` nothing is sent, nothing is queried, and the shop insights card says
"BigQuery isn't set up yet". Code: `server/src/core/analytics.ts`; tests: `server/test/analytics.test.ts`.

## What is exported (no personal data)

| Table | When | Columns |
|---|---|---|
| `requests` | A request is made | `at`, `category`, `area`, `item`, `units` |
| `deals` | A deal is paid — in the app (test mode) or marked paid outside | `at`, `category`, `area`, `item`, `units`, `unit_price`, `listed`, `currency`, `seller_hash`, `buyer_hash` |
| `demand_misses` | A buyer wanted more than the seller had | `at`, `category`, `area`, `item`, `wanted`, `available`, `seller_hash` |

- `area` is the public area (a neighbourhood or city name), never a home address or coordinates.
- `item` is the short item name from the listing or the request's title ("Steel water bottles"), at most 60 characters.
- People appear only as `seller_hash` / `buyer_hash`: an HMAC-SHA256 of the account id keyed with the server's secret
  (`AGENT_SECRET`). One seller's rows can be grouped; nobody can be named, and the hash can't be recomputed without the
  secret. A miss carries no buyer at all.
- Never exported: names, handles, account ids, request text, private notes, private limits ("up to ₹X"), budgets,
  messages, contact details, payment tokens.
- Rows are streamed with `tabledata.insertAll`, fire-and-forget with a 5-second timeout. If BigQuery is down or not
  permitted, the server logs a warning and the user's request goes on as normal.

## Set up

1. Create the dataset and tables (safe to run again; it grants nothing):
   ```sh
   ./scripts/setup-bigquery.sh collab-55 collab_analytics asia-south1
   ```
2. Run the two IAM commands the script prints (the server's account is `collab-market@collab-55.iam.gserviceaccount.com`):
   `roles/bigquery.dataEditor` on the dataset (to add rows) and `roles/bigquery.jobUser` on the project (to run the
   forecast query).
3. Add `BQ_DATASET=collab_analytics` to `deploy/<environment>.env` and deploy. `deploy.sh` passes it through; empty
   means off. The server uses `GOOGLE_CLOUD_PROJECT` for the project.

If `AI.FORECAST` isn't offered in your dataset's region, create the dataset in the `US` or `EU` multi-region instead
(third argument to the script).

## The forecast

`GET /api/shop/insights` gains `forecast: { available, reason?, items: [{ label, next7 }] }` — one item per category
the seller lists publicly, `label` being the category in plain words. Each category is one query (below), with the
category and the seller's area as named query parameters, never written into the SQL. The result is kept in Firestore
(`forecasts`, one document per seller per day), so opening the card again doesn't run another query; a failed
forecast is tried again after an hour.

```sql
SELECT forecast_timestamp, forecast_value, ai_forecast_status FROM AI.FORECAST((
  SELECT day, COUNT(r.at) AS n
  FROM UNNEST(GENERATE_DATE_ARRAY(DATE_SUB(CURRENT_DATE(), INTERVAL 90 DAY), DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY))) AS day
  LEFT JOIN `collab-55.collab_analytics.requests` AS r
    ON DATE(r.at) = day AND r.category = @category AND (@area = '' OR r.area = @area)
  GROUP BY day),
  data_col => 'n', timestamp_col => 'day', horizon => 7)
```

Days with no requests count as 0, so the series has no gaps. `next7` is the sum of the seven daily forecasts (below
zero counts as none), rounded. A non-empty `ai_forecast_status` (too little history, for example) means no forecast.

## A Looker Studio dashboard

1. Open [Looker Studio](https://lookerstudio.google.com) → **Create** → **Report**.
2. **Add data** → **BigQuery** → project `collab-55` → dataset `collab_analytics` → table `requests` → **Add**.
3. Add the other two tables the same way (**Resource** → **Manage added data sources** → **Add a data source**).
4. Set `at` as the date dimension on each source (it is detected as Date & Time; change it to Date for daily charts).
5. Requests: a **Time series** chart (dimension `at`, metric Record Count), broken down by `category`; add a
   **Control** → **Drop-down list** on `area` and another on `category`.
6. Deals: a **Table** of `item` with metrics Record Count, SUM(`units`), AVG(`unit_price`), AVG(`listed`); add a
   calculated field `discount` = `(listed - unit_price) / listed` and show its average.
7. Missed demand: a **Bar chart** of `item` by SUM(`wanted`) − SUM(`available`) (a calculated field `short` =
   `wanted - available`), sorted descending.
8. Forecast: **Add data** → **BigQuery** → **Custom query** → paste the query above with `'goods'` and `''` in place
   of `@category` and `@area` (or add them as report parameters), and chart `forecast_value` by `forecast_timestamp`.
9. Keep the report's sharing to the shop owner and team: it has no personal data, but sales numbers are still
   commercial.
