#!/usr/bin/env bash
# Creates the BigQuery dataset and the three tables Collab copies commerce events into (see docs/BIGQUERY.md). Safe to
# run again: nothing that exists is changed. It does NOT grant any access — it prints the two IAM commands for the
# owner to run themselves. Needs `gcloud auth login` and the bq tool (part of the Google Cloud SDK).
set -euo pipefail

# Usage: ./scripts/setup-bigquery.sh [project] [dataset] [location] [service]
PROJECT="${1:-${PROJECT:-collab-55}}"
DATASET="${2:-${BQ_DATASET:-collab_analytics}}"
LOCATION="${3:-${BQ_LOCATION:-asia-south1}}"
SERVICE="${4:-${SERVICE:-collab-market}}"
SA="${SERVICE}@${PROJECT}.iam.gserviceaccount.com"
T="\`${PROJECT}.${DATASET}"

echo "BigQuery: ${PROJECT}:${DATASET} in ${LOCATION}"
bq --project_id="$PROJECT" show --dataset "${PROJECT}:${DATASET}" >/dev/null 2>&1 \
  || bq --project_id="$PROJECT" --location="$LOCATION" mk --dataset --description "Collab commerce events (no personal data)" "${PROJECT}:${DATASET}"

# Partitioned by day: the forecast reads 90 days, not the whole history.
bq --project_id="$PROJECT" --location="$LOCATION" query --use_legacy_sql=false --quiet "
CREATE TABLE IF NOT EXISTS ${T}.requests\` (
  \`at\` TIMESTAMP NOT NULL, category STRING, area STRING, item STRING, units INT64
) PARTITION BY DATE(\`at\`) OPTIONS (description = 'A request was made: category, public area, item, how many');
CREATE TABLE IF NOT EXISTS ${T}.deals\` (
  \`at\` TIMESTAMP NOT NULL, category STRING, area STRING, item STRING, units INT64,
  unit_price FLOAT64, listed FLOAT64, currency STRING, seller_hash STRING, buyer_hash STRING
) PARTITION BY DATE(\`at\`) OPTIONS (description = 'A deal was paid; people only as keyed hashes');
CREATE TABLE IF NOT EXISTS ${T}.demand_misses\` (
  \`at\` TIMESTAMP NOT NULL, category STRING, area STRING, item STRING, wanted INT64, available INT64, seller_hash STRING
) PARTITION BY DATE(\`at\`) OPTIONS (description = 'A buyer wanted more than the seller had');
"
echo "Tables ready: requests, deals, demand_misses."

cat <<MSG

Not done for you — run these yourself to let the server write rows and run the forecast:

  bq add-iam-policy-binding --member="serviceAccount:${SA}" --role="roles/bigquery.dataEditor" "${PROJECT}:${DATASET}"
  gcloud projects add-iam-policy-binding ${PROJECT} --member="serviceAccount:${SA}" --role="roles/bigquery.jobUser"

(If your bq has no add-iam-policy-binding, grant dataEditor on the project instead:
  gcloud projects add-iam-policy-binding ${PROJECT} --member="serviceAccount:${SA}" --role="roles/bigquery.dataEditor")

Then deploy with BQ_DATASET=${DATASET} in deploy/<environment>.env.
MSG
