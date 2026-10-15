#!/usr/bin/env bash
# One-time monitoring setup: an uptime check on /health from several regions every 5 minutes, and an e-mail alert when
# it fails. Errors logged by the server (log.error) show up in Error Reporting on their own.
set -euo pipefail
PROJECT="${PROJECT:-collab-55}"
EMAIL="${ALERT_EMAIL:?set ALERT_EMAIL to where alerts should go}"
HOST="${PROJECT}.web.app"
gcloud config set project "$PROJECT" >/dev/null

CHECK_ID="$(gcloud monitoring uptime list-configs --filter='displayName="collab health"' --format='value(name)' | head -1)"
if [ -z "$CHECK_ID" ]; then
  gcloud monitoring uptime create "collab health" --resource-type=uptime-url --resource-labels="host=$HOST,project_id=$PROJECT" \
    --protocol=https --path=/health --period=5 --timeout=10 --matcher-content='"ok":true' --matcher-type=contains-string >/dev/null
  CHECK_ID="$(gcloud monitoring uptime list-configs --filter='displayName="collab health"' --format='value(name)' | head -1)"
fi
CHECK="${CHECK_ID##*/}"

CHANNEL="$(gcloud beta monitoring channels list --filter="labels.email_address=\"$EMAIL\"" --format='value(name)' | head -1)"
[ -n "$CHANNEL" ] || CHANNEL="$(gcloud beta monitoring channels create --display-name="Collab alerts" --type=email --channel-labels="email_address=$EMAIL" --format='value(name)')"

if ! gcloud alpha monitoring policies list --filter='displayName="Collab is down"' --format='value(name)' | grep -q .; then
  cat > /tmp/collab-policy.json <<JSON
{
  "displayName": "Collab is down",
  "combiner": "OR",
  "conditions": [{
    "displayName": "/health failing",
    "conditionThreshold": {
      "filter": "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND metric.label.check_id=\"$CHECK\" AND resource.type=\"uptime_url\"",
      "comparison": "COMPARISON_GT", "thresholdValue": 1, "duration": "300s",
      "aggregations": [{ "alignmentPeriod": "300s", "perSeriesAligner": "ALIGN_NEXT_OLDER", "crossSeriesReducer": "REDUCE_COUNT_FALSE", "groupByFields": ["resource.label.project_id"] }],
      "trigger": { "count": 1 }
    }
  }],
  "notificationChannels": ["$CHANNEL"]
}
JSON
  gcloud alpha monitoring policies create --policy-from-file=/tmp/collab-policy.json >/dev/null
fi
# Errors: more than 5 % of requests answered 5xx for 5 minutes.
if ! gcloud alpha monitoring policies list --filter='displayName="Collab errors"' --format='value(name)' | grep -q .; then
  cat > /tmp/collab-errors.json <<JSON
{
  "displayName": "Collab errors",
  "combiner": "OR",
  "conditions": [{
    "displayName": "5xx above 5% for 5 min",
    "conditionThreshold": {
      "filter": "metric.type=\"run.googleapis.com/request_count\" AND resource.type=\"cloud_run_revision\" AND resource.label.service_name=\"collab-market\" AND metric.label.response_code_class=\"5xx\"",
      "comparison": "COMPARISON_GT", "thresholdValue": 5, "duration": "300s",
      "aggregations": [{ "alignmentPeriod": "300s", "perSeriesAligner": "ALIGN_RATE", "crossSeriesReducer": "REDUCE_SUM" }],
      "trigger": { "count": 1 }
    }
  }],
  "notificationChannels": ["$CHANNEL"]
}
JSON
  gcloud alpha monitoring policies create --policy-from-file=/tmp/collab-errors.json >/dev/null
fi

# Product events: the server logs one line per event (log.ts → event()); each becomes a counter you can chart.
for ev in signup request_sent agents_contacted deal_agreed paid collected goal_cancelled appcheck_unverified order_sent; do
  gcloud logging metrics describe "collab_$ev" >/dev/null 2>&1 || gcloud logging metrics create "collab_$ev" \
    --description="Collab product event: $ev" \
    --log-filter="resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"collab-market\" AND jsonPayload.message=\"event\" AND jsonPayload.event=\"$ev\"" >/dev/null
done

# The dashboard: traffic, latency, errors, instances, and the product funnel.
if ! gcloud monitoring dashboards list --filter='displayName="Collab"' --format='value(name)' | grep -q .; then
  python3 - > /tmp/collab-dashboard.json <<'PY'
import json
def ts(filter, aligner="ALIGN_RATE", reducer="REDUCE_SUM", group=None):
    a = {"alignmentPeriod": "300s", "perSeriesAligner": aligner, "crossSeriesReducer": reducer}
    if group: a["groupByFields"] = group
    return {"timeSeriesQuery": {"timeSeriesFilter": {"filter": filter, "aggregation": a}}, "plotType": "LINE"}
run = 'resource.type="cloud_run_revision" AND resource.label.service_name="collab-market"'
tiles = [
  ("Requests / s", [ts(f'metric.type="run.googleapis.com/request_count" AND {run}', group=["metric.label.response_code_class"])]),
  ("Latency p95 (ms)", [ts(f'metric.type="run.googleapis.com/request_latencies" AND {run}', "ALIGN_DELTA", "REDUCE_PERCENTILE_95")]),
  ("Instances", [ts(f'metric.type="run.googleapis.com/container/instance_count" AND {run}', "ALIGN_MAX", "REDUCE_MAX")]),
  ("Sign-ups / 5 min", [ts('metric.type="logging.googleapis.com/user/collab_signup"')]),
  ("Funnel: requests · contacts · deals / 5 min", [ts(f'metric.type="logging.googleapis.com/user/collab_{e}"') for e in ("request_sent", "agents_contacted", "deal_agreed")]),
  ("Payments and pickups / 5 min", [ts(f'metric.type="logging.googleapis.com/user/collab_{e}"') for e in ("paid", "collected")]),
]
print(json.dumps({"displayName": "Collab", "mosaicLayout": {"columns": 12, "tiles": [
  {"xPos": (i % 2) * 6, "yPos": (i // 2) * 4, "width": 6, "height": 4, "widget": {"title": t, "xyChart": {"dataSets": d}}} for i, (t, d) in enumerate(tiles)]}}))
PY
  gcloud monitoring dashboards create --config-from-file=/tmp/collab-dashboard.json >/dev/null
fi
echo "Uptime check: $CHECK · error alert · product metrics · dashboard 'Collab' · alerts to $EMAIL"
