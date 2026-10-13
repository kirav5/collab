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

# A new service account takes a few seconds to be usable in policies: retry until it is.
for role in roles/aiplatform.user roles/datastore.user roles/firebaseauth.viewer roles/firebasecloudmessaging.admin; do
  for try in 1 2 3 4 5 6; do
    gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$SA" --role "$role" --condition None >/dev/null 2>&1 && break
    [ "$try" = 6 ] && { echo "Couldn't grant $role to $SA"; exit 1; }
    sleep 10
  done
done
gcloud secrets add-iam-policy-binding agent-secret --member "serviceAccount:$SA" --role roles/secretmanager.secretAccessor >/dev/null

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
  --set-secrets "AGENT_SECRET=agent-secret:latest" \
  --set-env-vars "^##^GOOGLE_CLOUD_PROJECT=$PROJECT##GOOGLE_CLOUD_LOCATION=global##GEMINI_MODELS=$MODELS##SEED_DEMO=1##PUBLIC_URL=$SITE##FIREBASE_WEB_CONFIG=$FIREBASE_WEB_CONFIG##RECAPTCHA_SITE_KEY=$RECAPTCHA_SITE_KEY##APPCHECK=$APPCHECK"

# The version open apps compare against when they come back to the front (they reload into a new one).
echo "$(git rev-parse --short HEAD 2>/dev/null || echo dev)-$(date +%s)" > web/version.txt
firebase deploy --project "$PROJECT" --only hosting,firestore --non-interactive

# Scheduled agents: Cloud Scheduler runs the due watches every 15 minutes (the token is derived from the agent secret).
RUN_URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format 'value(status.url)')"
CRON_TOKEN="$(gcloud secrets versions access latest --secret=agent-secret | tr -d '\n' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(require("crypto").createHmac("sha256",s).update("collab-cron").digest("base64url")))')"
if gcloud scheduler jobs describe collab-watches --location "$REGION" >/dev/null 2>&1; then
  gcloud scheduler jobs update http collab-watches --location "$REGION" --schedule "*/15 * * * *" --uri "$RUN_URL/cron/run" --http-method POST --update-headers "x-collab-cron=$CRON_TOKEN" --quiet >/dev/null
else
  gcloud scheduler jobs create http collab-watches --location "$REGION" --schedule "*/15 * * * *" --uri "$RUN_URL/cron/run" --http-method POST --headers "x-collab-cron=$CRON_TOKEN" --quiet >/dev/null
fi

echo
echo "Web app:     $SITE"
echo "Cloud Run:   $(gcloud run services describe "$SERVICE" --region "$REGION" --format 'value(status.url)')"
echo "A2A example: $SITE/a2a/riya/.well-known/agent-card.json"
