#!/usr/bin/env bash
# (Re)aplica la configuración completa del App Client de Cognito.
# update-user-pool-client restablece lo que no se envía, por eso siempre se manda todo.
set -euo pipefail
cd "$(dirname "$0")/.."
REGION="${AWS_REGION:-us-east-2}"
source infra/state.env
CALLBACKS="http://localhost:3000/auth/cognito/callback"
[ -n "${CF_DOMAIN:-}" ] && CALLBACKS="$CALLBACKS https://$CF_DOMAIN/auth/cognito/callback"
IDPS="COGNITO"
[ "${GOOGLE_IDP:-}" = "1" ] && IDPS="COGNITO Google"

aws cognito-idp update-user-pool-client --region "$REGION" --user-pool-id "$POOL_ID" --client-id "$CLIENT_ID" \
  --client-name techstore-web \
  --explicit-auth-flows ALLOW_USER_PASSWORD_AUTH ALLOW_REFRESH_TOKEN_AUTH \
  --prevent-user-existence-errors ENABLED \
  --auth-session-validity 5 \
  --id-token-validity 60 --access-token-validity 60 --refresh-token-validity 1 \
  --token-validity-units IdToken=minutes,AccessToken=minutes,RefreshToken=days \
  --supported-identity-providers $IDPS \
  --callback-urls $CALLBACKS \
  --allowed-o-auth-flows code --allowed-o-auth-scopes openid email profile \
  --allowed-o-auth-flows-user-pool-client \
  --read-attributes email email_verified name custom:store \
  --write-attributes email name custom:store >/dev/null
