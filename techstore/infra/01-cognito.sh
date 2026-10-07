#!/usr/bin/env bash
# Crea el Amazon Cognito User Pool de TechStore:
#  - política de contraseñas (8+, mayúscula, número, símbolo)
#  - MFA obligatorio por TOTP (Google Authenticator)
#  - atributo personalizado custom:store (tienda asignada)
#  - grupos = roles (ADMIN, GERENTE, EMPLEADO, AUDITOR)
#  - app client sin secreto para la web + dominio Hosted UI (login con Google)
#  - usuario administrador inicial
set -euo pipefail
cd "$(dirname "$0")/.."
REGION="${AWS_REGION:-us-east-2}"
STATE=infra/state.env
touch "$STATE"; source "$STATE"
ADMIN_EMAIL=$(grep '^ADMIN_EMAIL=' .env | cut -d= -f2- | tr -d '"')
ADMIN_PASSWORD=$(grep '^ADMIN_PASSWORD=' .env | cut -d= -f2- | tr -d '"')
save() { grep -v "^$1=" "$STATE" > "$STATE.tmp" || true; echo "$1=$2" >> "$STATE.tmp"; mv "$STATE.tmp" "$STATE"; }

if [ -z "${POOL_ID:-}" ]; then
  echo "» Creando User Pool..."
  POOL_ID=$(aws cognito-idp create-user-pool --region "$REGION" \
    --pool-name techstore-usuarios \
    --policies 'PasswordPolicy={MinimumLength=8,RequireUppercase=true,RequireLowercase=false,RequireNumbers=true,RequireSymbols=true,TemporaryPasswordValidityDays=1}' \
    --username-attributes email \
    --schema 'Name=store,AttributeDataType=String,Mutable=true,StringAttributeConstraints={MinLength=1,MaxLength=40}' \
    --account-recovery-setting 'RecoveryMechanisms=[{Priority=1,Name=verified_email}]' \
    --admin-create-user-config AllowAdminCreateUserOnly=false \
    --user-pool-tags Proyecto=TechStore \
    --query UserPool.Id --output text)
  save POOL_ID "$POOL_ID"
fi
echo "  User Pool: $POOL_ID"

echo "» Activando MFA obligatorio (TOTP)..."
aws cognito-idp set-user-pool-mfa-config --region "$REGION" --user-pool-id "$POOL_ID" \
  --software-token-mfa-configuration Enabled=true --mfa-configuration ON >/dev/null

echo "» Creando grupos (roles)..."
i=0
for g in "ADMIN:Administrador del Sistema - acceso total" "GERENTE:Gerente de Tienda - productos y reportes de su tienda" \
         "EMPLEADO:Empleado de Ventas - consulta y actualiza stock" "AUDITOR:Auditor - solo lectura"; do
  i=$((i+1))
  aws cognito-idp create-group --region "$REGION" --user-pool-id "$POOL_ID" --group-name "${g%%:*}" \
    --description "${g#*:}" --precedence $i >/dev/null 2>&1 || true
done

if [ -z "${DOMAIN_PREFIX:-}" ]; then
  DOMAIN_PREFIX="techstore-$(openssl rand -hex 4)"
  aws cognito-idp create-user-pool-domain --region "$REGION" --user-pool-id "$POOL_ID" --domain "$DOMAIN_PREFIX" >/dev/null
  save DOMAIN_PREFIX "$DOMAIN_PREFIX"
fi
echo "  Dominio Hosted UI: $DOMAIN_PREFIX.auth.$REGION.amazoncognito.com"

if [ -z "${CLIENT_ID:-}" ]; then
  echo "» Creando App Client..."
  CLIENT_ID=$(aws cognito-idp create-user-pool-client --region "$REGION" --user-pool-id "$POOL_ID" \
    --client-name techstore-web --no-generate-secret \
    --query UserPoolClient.ClientId --output text)
  save CLIENT_ID "$CLIENT_ID"
fi
bash infra/update-client.sh
echo "  App Client: $CLIENT_ID"

echo "» Usuario administrador inicial ($ADMIN_EMAIL)..."
aws cognito-idp admin-create-user --region "$REGION" --user-pool-id "$POOL_ID" --username "$ADMIN_EMAIL" \
  --user-attributes Name=email,Value="$ADMIN_EMAIL" Name=email_verified,Value=true \
  Name=name,Value="Administrador TechStore" Name=custom:store,Value=Central \
  --message-action SUPPRESS >/dev/null 2>&1 || true
aws cognito-idp admin-set-user-password --region "$REGION" --user-pool-id "$POOL_ID" --username "$ADMIN_EMAIL" \
  --password "$ADMIN_PASSWORD" --permanent
aws cognito-idp admin-add-user-to-group --region "$REGION" --user-pool-id "$POOL_ID" --username "$ADMIN_EMAIL" --group-name ADMIN

# Variables para la app local
for kv in "AUTH_PROVIDER=cognito" "AWS_REGION=$REGION" "COGNITO_USER_POOL_ID=$POOL_ID" \
          "COGNITO_CLIENT_ID=$CLIENT_ID" "COGNITO_DOMAIN=$DOMAIN_PREFIX.auth.$REGION.amazoncognito.com"; do
  k=${kv%%=*}; grep -v "^$k=" .env > .env.tmp || true; echo "$kv" >> .env.tmp; mv .env.tmp .env
done
echo "✔ Cognito listo. Variables agregadas a .env"
