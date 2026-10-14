#!/usr/bin/env bash
# Deploys Collab: the server to Cloud Run (built from the Dockerfile by Cloud Build), then the web app, Firestore
# rules and the vector index to Firebase. Needs `gcloud auth login` and `firebase login` first.
set -euo pipefail

PROJECT="${PROJECT:-collab-55}"
REGION="${REGION:-asia-south1}"
SERVICE="collab-market"
SA="collab-market@${PROJECT}.iam.gserviceaccount.com"
SITE="https://${PROJECT}.web.app"
MODELS="${GEMINI_MODELS:-gemini-3.6-flash,gemini-3.8-flash,gemini-3.5-flash-lite}"

cd "$(dirname "$0")"
gcloud config set project "$PROJECT" >/dev/null

# The secret our users' agents sign their A2A calls with lives in Secret Manager (made once; never in git or in the
# service's plain environment).
if ! gcloud secrets describe agent-secret >/dev/null 2>&1; then
  mkdir -p .deploy
  [ -f .deploy/agent-secret ] || openssl rand -hex 32 > .deploy/agent-secret
  gcloud secrets create agent-secret --replication-policy=automatic --data-file=.deploy/agent-secret >/dev/null
fi
# Receipt signing is separate from A2A authentication. Keep this key stable across instances and deploys.
if ! gcloud secrets describe receipt-key >/dev/null 2>&1; then
  mkdir -p .deploy
  (umask 077; [ -f .deploy/receipt-key ] || openssl genpkey -algorithm ED25519 -out .deploy/receipt-key)
  gcloud secrets create receipt-key --replication-policy=automatic --data-file=.deploy/receipt-key >/dev/null
fi
RECAPTCHA_SITE_KEY="${RECAPTCHA_SITE_KEY:-6LcWVO0tAAAAAGE87CLYa8anCDcS9mnidBl2geJN}"
APPCHECK="${APPCHECK:-monitor}"

# The web config is public (Firebase Hosting serves it too); the Cloud Run URL uses it when opened directly.
FIREBASE_WEB_CONFIG="$(firebase apps:sdkconfig web --project "$PROJECT" 2>/dev/null | sed -n '/^{/,/^}/p' | tr -d '\n' || true)"

# The server runs as its own service account: Gemini through Vertex AI, Firestore, and checking Firebase sign-ins.
if ! gcloud iam service-accounts describe "$SA" >/dev/null 2>&1; then
  gcloud iam service-accounts create collab-market --display-name "Collab server"
fi
# Rate-limit counters and leases expire on their own (Firestore TTL on expireAt).
for group in rate leases; do
  gcloud firestore fields ttls update expireAt --collection-group="$group" --enable-ttl --async --quiet >/dev/null 2>&1 || true
done

# Model Armor: one template screens what other agents send (prompt injection / jailbreak), one checks answers before
# they're shared (sensitive data). asia-south1 doesn't offer the malicious-URL filter.
ARMOR_LOCATION="${ARMOR_LOCATION:-asia-south1}"
gcloud services enable modelarmor.googleapis.com --project "$PROJECT" >/dev/null
ARMOR=(--project "$PROJECT" --location "$ARMOR_LOCATION")
export CLOUDSDK_API_ENDPOINT_OVERRIDES_MODELARMOR="https://modelarmor.$ARMOR_LOCATION.rep.googleapis.com/"
gcloud model-armor templates describe collab-incoming "${ARMOR[@]}" >/dev/null 2>&1 || gcloud model-armor templates create collab-incoming "${ARMOR[@]}" \
  --pi-and-jailbreak-filter-settings-enforcement=enabled --pi-and-jailbreak-filter-settings-confidence-level=medium-and-above --template-metadata-log-sanitize-operations >/dev/null
gcloud model-armor templates describe collab-outgoing "${ARMOR[@]}" >/dev/null 2>&1 || gcloud model-armor templates create collab-outgoing "${ARMOR[@]}" \
  --basic-config-filter-enforcement=enabled --template-metadata-log-sanitize-operations >/dev/null
unset CLOUDSDK_API_ENDPOINT_OVERRIDES_MODELARMOR

# A new service account takes a few seconds to be usable in policies: retry until it is.
for role in roles/aiplatform.user roles/datastore.user roles/firebaseauth.viewer roles/firebasecloudmessaging.admin roles/firebaseappcheck.tokenVerifier roles/modelarmor.user roles/cloudtasks.enqueuer; do
  for try in 1 2 3 4 5 6; do
    gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$SA" --role "$role" --condition None >/dev/null 2>&1 && break
    [ "$try" = 6 ] && { echo "Couldn't grant $role to $SA"; exit 1; }
    sleep 10
  done
done
gcloud secrets add-iam-policy-binding agent-secret --member "serviceAccount:$SA" --role roles/secretmanager.secretAccessor >/dev/null

gcloud secrets add-iam-policy-binding receipt-key --member "serviceAccount:$SA" --role roles/secretmanager.secretAccessor >/dev/null

# Cloud Tasks: waiting agent turns re-run on the server. The service mints OIDC tokens for itself (actAs on its own
# account) so the handler can check the caller.
gcloud services enable cloudtasks.googleapis.com --project "$PROJECT" >/dev/null
gcloud tasks queues describe collab-turns --location "$REGION" --project "$PROJECT" >/dev/null 2>&1 || \
  gcloud tasks queues create collab-turns --location "$REGION" --project "$PROJECT" --max-attempts 5 --min-backoff 5s --max-dispatches-per-second 10 >/dev/null
gcloud iam service-accounts add-iam-policy-binding "$SA" --project "$PROJECT" --member "serviceAccount:$SA" --role roles/iam.serviceAccountUser >/dev/null
# Build identity: the same id is served by the API (/health) and the web app (version.txt), so a deployment can be
# matched to its source. "-dirty" marks uncommitted changes.
BUILD_ID="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)$(git diff --quiet 2>/dev/null || echo -dirty)-$(date +%s)"
RUN_URL_NOW=$(gcloud run services describe "$SERVICE" --region "$REGION" --project "$PROJECT" --format 'value(status.url)' 2>/dev/null || true)

# Request-based billing (CPU only while a request runs); one instance kept warm so the app never waits ~3 s for a cold
# start (MIN_INSTANCES=0 turns that off), startup CPU boost for when a second one starts, at most 2 instances caps cost.
gcloud run deploy "$SERVICE" --quiet \
  --source . \
  --region "$REGION" \
  --service-account "$SA" \
  --allow-unauthenticated \
  --memory 1Gi --cpu 1 --concurrency 40 \
  --min-instances "${MIN_INSTANCES:-1}" --max-instances 2 --cpu-boost \
  --timeout 60 \
  --set-secrets "AGENT_SECRET=agent-secret:latest,RECEIPT_KEY=receipt-key:latest" \
  --set-env-vars "^##^GOOGLE_CLOUD_PROJECT=$PROJECT##GOOGLE_CLOUD_LOCATION=global##GEMINI_MODELS=$MODELS##SEED_DEMO=1##PUBLIC_URL=$SITE##FIREBASE_WEB_CONFIG=$FIREBASE_WEB_CONFIG##RECAPTCHA_SITE_KEY=$RECAPTCHA_SITE_KEY##APPCHECK=$APPCHECK##MODEL_ARMOR_LOCATION=$ARMOR_LOCATION##MODEL_ARMOR_INCOMING=collab-incoming##MODEL_ARMOR_OUTGOING=collab-outgoing##TASKS_QUEUE=projects/$PROJECT/locations/$REGION/queues/collab-turns##TASKS_SERVICE_ACCOUNT=$SA##RUN_URL=$RUN_URL_NOW##BUILD_ID=$BUILD_ID"

# The version open apps compare against when they come back to the front (they reload into a new one).
echo "$BUILD_ID" > web/version.txt
firebase deploy --project "$PROJECT" --only hosting,firestore --non-interactive

# Scheduled agents: Cloud Scheduler runs the due watches every 15 minutes (the token is derived from the agent secret).
RUN_URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format 'value(status.url)')"
CRON_TOKEN="$(gcloud secrets versions access latest --secret=agent-secret | tr -d '\n' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(require("crypto").createHmac("sha256",s).update("collab-cron").digest("base64url")))')"
if gcloud scheduler jobs describe collab-watches --location "$REGION" >/dev/null 2>&1; then
  gcloud scheduler jobs update http collab-watches --location "$REGION" --schedule "*/15 * * * *" --uri "$RUN_URL/cron/run" --http-method POST --update-headers "x-collab-cron=$CRON_TOKEN" --quiet >/dev/null
else
  gcloud scheduler jobs create http collab-watches --location "$REGION" --schedule "*/15 * * * *" --uri "$RUN_URL/cron/run" --http-method POST --headers "x-collab-cron=$CRON_TOKEN" --quiet >/dev/null
fi
# Outbox recovery every minute: waiting agent turns that weren't queued are queued again.
if gcloud scheduler jobs describe collab-recovery --location "$REGION" >/dev/null 2>&1; then
  gcloud scheduler jobs update http collab-recovery --location "$REGION" --schedule "* * * * *" --uri "$RUN_URL/cron/recover" --http-method POST --update-headers "x-collab-cron=$CRON_TOKEN" --quiet >/dev/null
else
  gcloud scheduler jobs create http collab-recovery --location "$REGION" --schedule "* * * * *" --uri "$RUN_URL/cron/recover" --http-method POST --headers "x-collab-cron=$CRON_TOKEN" --quiet >/dev/null
fi

echo
echo "Web app:     $SITE"
echo "Cloud Run:   $(gcloud run services describe "$SERVICE" --region "$REGION" --format 'value(status.url)')"
echo "A2A example: $SITE/a2a/riya/.well-known/agent-card.json"
