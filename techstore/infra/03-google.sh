#!/usr/bin/env bash
# Registra Google como proveedor de identidad (IdP federado) en el User Pool de Cognito.
# Requiere GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET en techstore/.env (Google Cloud Console).
set -euo pipefail
cd "$(dirname "$0")/.."
REGION="${AWS_REGION:-us-east-2}"
STATE=infra/state.env
source "$STATE"
GID=$(grep '^GOOGLE_CLIENT_ID=' .env | cut -d= -f2- | tr -d '"')
GSECRET=$(grep '^GOOGLE_CLIENT_SECRET=' .env | cut -d= -f2- | tr -d '"')
[ -z "$GID" ] || [ -z "$GSECRET" ] && { echo "Falta GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET en .env"; exit 1; }

DETAILS="client_id=$GID,client_secret=$GSECRET,authorize_scopes=openid email profile"
MAP='email=email,name=name,username=sub'
if aws cognito-idp describe-identity-provider --region "$REGION" --user-pool-id "$POOL_ID" --provider-name Google >/dev/null 2>&1; then
  aws cognito-idp update-identity-provider --region "$REGION" --user-pool-id "$POOL_ID" --provider-name Google \
    --provider-details "$DETAILS" --attribute-mapping "$MAP" >/dev/null
else
  aws cognito-idp create-identity-provider --region "$REGION" --user-pool-id "$POOL_ID" --provider-name Google \
    --provider-type Google --provider-details "$DETAILS" --attribute-mapping "$MAP" >/dev/null
fi
grep -v '^GOOGLE_IDP=' "$STATE" > "$STATE.tmp" || true; echo "GOOGLE_IDP=1" >> "$STATE.tmp"; mv "$STATE.tmp" "$STATE"
bash infra/update-client.sh

# La app usará el login con Google a través de Cognito (no directo con Passport).
grep -v '^COGNITO_GOOGLE=' .env > .env.tmp || true; echo "COGNITO_GOOGLE=1" >> .env.tmp; mv .env.tmp .env
echo "✔ Google conectado a Cognito. Reinicia el servidor (npm start)."
