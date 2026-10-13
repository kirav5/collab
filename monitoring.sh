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
echo "Uptime check: $CHECK · alerts to $EMAIL"
