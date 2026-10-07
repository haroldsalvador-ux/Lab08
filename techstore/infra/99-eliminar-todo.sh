#!/usr/bin/env bash
# Elimina todos los recursos de AWS creados para TechStore (para no generar costos).
set -uo pipefail
cd "$(dirname "$0")/.."
REGION="${AWS_REGION:-us-east-2}"
source infra/state.env
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)

if [ -n "${CF_ID:-}" ]; then
  echo "» Deshabilitando CloudFront..."
  ETAG=$(aws cloudfront get-distribution-config --region us-east-1 --id "$CF_ID" --query ETag --output text)
  aws cloudfront get-distribution-config --region us-east-1 --id "$CF_ID" --query DistributionConfig | jq '.Enabled=false' > /tmp/cf-off.json
  aws cloudfront update-distribution --region us-east-1 --id "$CF_ID" --if-match "$ETAG" --distribution-config file:///tmp/cf-off.json >/dev/null
  aws cloudfront wait --region us-east-1 distribution-deployed --id "$CF_ID"
  ETAG=$(aws cloudfront get-distribution-config --region us-east-1 --id "$CF_ID" --query ETag --output text)
  aws cloudfront delete-distribution --region us-east-1 --id "$CF_ID" --if-match "$ETAG"
fi
if [ -n "${INSTANCE_ID:-}" ]; then
  echo "» Terminando EC2..."
  aws ec2 terminate-instances --region "$REGION" --instance-ids "$INSTANCE_ID" >/dev/null
  aws ec2 wait instance-terminated --region "$REGION" --instance-ids "$INSTANCE_ID"
fi
[ -n "${SG_ID:-}" ] && aws ec2 delete-security-group --region "$REGION" --group-id "$SG_ID"
aws iam remove-role-from-instance-profile --instance-profile-name techstore-ec2-role --role-name techstore-ec2-role 2>/dev/null
aws iam delete-instance-profile --instance-profile-name techstore-ec2-role 2>/dev/null
aws iam delete-role-policy --role-name techstore-ec2-role --policy-name techstore-app 2>/dev/null
aws iam detach-role-policy --role-name techstore-ec2-role --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore 2>/dev/null
aws iam delete-role --role-name techstore-ec2-role 2>/dev/null
aws s3 rb "s3://techstore-deploy-$ACCOUNT-$REGION" --force 2>/dev/null
for p in $(aws ssm get-parameters-by-path --region "$REGION" --path /techstore --query 'Parameters[].Name' --output text); do
  aws ssm delete-parameter --region "$REGION" --name "$p"
done
if [ -n "${POOL_ID:-}" ]; then
  echo "» Eliminando Cognito..."
  aws cognito-idp delete-user-pool-domain --region "$REGION" --user-pool-id "$POOL_ID" --domain "$DOMAIN_PREFIX" 2>/dev/null
  aws cognito-idp delete-user-pool --region "$REGION" --user-pool-id "$POOL_ID"
fi
: > infra/state.env
echo "✔ Recursos eliminados"
