#!/usr/bin/env bash
# Despliega TechStore en AWS:
#   S3 (artefacto) -> EC2 Amazon Linux 2023 (IMDSv2, EBS cifrado, rol IAM, sin puerto SSH)
#   SSM Parameter Store (JWT_SECRET cifrado con KMS) -> CloudFront (HTTPS + cabeceras de seguridad)
#   Security Group: puerto 3000 abierto SOLO para CloudFront (prefix list administrada).
set -euo pipefail
cd "$(dirname "$0")/.."
REGION="${AWS_REGION:-us-east-2}"
STATE=infra/state.env
source "$STATE"
save() { grep -v "^$1=" "$STATE" > "$STATE.tmp" || true; echo "$1=$2" >> "$STATE.tmp"; mv "$STATE.tmp" "$STATE"; }
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
BUCKET="techstore-deploy-$ACCOUNT-$REGION"; save BUCKET "$BUCKET"
ROLE=techstore-ec2-role

echo "» SSM Parameter Store (SecureString / KMS)..."
JWT=$(grep '^JWT_SECRET=' .env | cut -d= -f2-)
aws ssm put-parameter --region "$REGION" --name /techstore/JWT_SECRET --type SecureString --value "$JWT" --overwrite >/dev/null
for kv in "AUTH_PROVIDER=cognito" "AWS_REGION=$REGION" "COGNITO_USER_POOL_ID=$POOL_ID" "COGNITO_CLIENT_ID=$CLIENT_ID" \
          "COGNITO_DOMAIN=$DOMAIN_PREFIX.auth.$REGION.amazoncognito.com" "ADMIN_EMAIL=$(grep '^ADMIN_EMAIL=' .env | cut -d= -f2-)" \
          "COGNITO_GOOGLE=${GOOGLE_IDP:-0}"; do
  aws ssm put-parameter --region "$REGION" --name "/techstore/${kv%%=*}" --type String --value "${kv#*=}" --overwrite >/dev/null
done

echo "» S3: subiendo el código ($BUCKET)..."
aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null || {
  if [ "$REGION" = us-east-1 ]; then aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" >/dev/null
  else aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" --create-bucket-configuration LocationConstraint="$REGION" >/dev/null; fi
  aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
}
rm -f /tmp/techstore.zip
zip -qr /tmp/techstore.zip server.js package.json package-lock.json src public
aws s3 cp /tmp/techstore.zip "s3://$BUCKET/techstore.zip" --region "$REGION" >/dev/null

echo "» IAM: rol de la instancia (mínimo privilegio)..."
if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE" --assume-role-policy-document \
    '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  aws iam attach-role-policy --role-name "$ROLE" --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
  aws iam create-instance-profile --instance-profile-name "$ROLE" >/dev/null
  aws iam add-role-to-instance-profile --instance-profile-name "$ROLE" --role-name "$ROLE"
  sleep 12 # propagación de IAM
fi
aws iam put-role-policy --role-name "$ROLE" --policy-name techstore-app --policy-document "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [
    {\"Effect\":\"Allow\",\"Action\":\"s3:GetObject\",\"Resource\":\"arn:aws:s3:::$BUCKET/*\"},
    {\"Effect\":\"Allow\",\"Action\":[\"ssm:GetParameter\",\"ssm:GetParametersByPath\"],\"Resource\":\"arn:aws:ssm:$REGION:$ACCOUNT:parameter/techstore*\"},
    {\"Effect\":\"Allow\",\"Action\":[\"cognito-idp:AdminConfirmSignUp\",\"cognito-idp:AdminAddUserToGroup\",
      \"cognito-idp:AdminRemoveUserFromGroup\",\"cognito-idp:AdminListGroupsForUser\"],
     \"Resource\":\"arn:aws:cognito-idp:$REGION:$ACCOUNT:userpool/$POOL_ID\"}
  ]}"

echo "» Security Group (solo CloudFront -> puerto 3000)..."
VPC=$(aws ec2 describe-vpcs --region "$REGION" --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)
if [ -z "${SG_ID:-}" ]; then
  SG_ID=$(aws ec2 create-security-group --region "$REGION" --group-name techstore-web-sg --vpc-id "$VPC" \
    --description "TechStore: solo trafico de CloudFront" --query GroupId --output text)
  PL=$(aws ec2 describe-managed-prefix-lists --region "$REGION" \
    --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing --query 'PrefixLists[0].PrefixListId' --output text)
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ID" \
    --ip-permissions "IpProtocol=tcp,FromPort=3000,ToPort=3000,PrefixListIds=[{PrefixListId=$PL,Description=CloudFront}]" >/dev/null
  save SG_ID "$SG_ID"
fi

if [ -z "${INSTANCE_ID:-}" ]; then
  echo "» EC2: lanzando t4g.micro (Amazon Linux 2023)..."
  AMI=$(aws ssm get-parameter --region "$REGION" --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64 --query Parameter.Value --output text)
  cat > /tmp/techstore-userdata.sh <<EOF
#!/bin/bash
set -eux
dnf install -y unzip tar xz
curl -fsSL https://nodejs.org/dist/v24.11.1/node-v24.11.1-linux-arm64.tar.xz | tar -xJ -C /opt
ln -sf /opt/node-v24.11.1-linux-arm64/bin/node /usr/local/bin/node
ln -sf /opt/node-v24.11.1-linux-arm64/bin/npm /usr/local/bin/npm
useradd -r -m -d /opt/techstore techstore || true
aws s3 cp s3://$BUCKET/techstore.zip /tmp/techstore.zip
unzip -o /tmp/techstore.zip -d /opt/techstore
cd /opt/techstore && /usr/local/bin/npm ci --omit=dev
cat > /opt/techstore/load-env.sh <<'EOS'
#!/bin/bash
# Lee la configuración desde SSM Parameter Store (JWT_SECRET descifrado con KMS)
aws ssm get-parameters-by-path --region $REGION --path /techstore --with-decryption \
  --query 'Parameters[].[Name,Value]' --output text | sed 's#^/techstore/##; s#\t#=#' > /opt/techstore/.env
echo "PORT=3000" >> /opt/techstore/.env
EOS
chmod +x /opt/techstore/load-env.sh
chown -R techstore:techstore /opt/techstore
cat > /etc/systemd/system/techstore.service <<'EOS'
[Unit]
Description=TechStore inventario
After=network-online.target
[Service]
User=techstore
WorkingDirectory=/opt/techstore
ExecStartPre=/opt/techstore/load-env.sh
ExecStart=/usr/local/bin/node server.js
Restart=always
[Install]
WantedBy=multi-user.target
EOS
systemctl daemon-reload
systemctl enable --now techstore
EOF
  for try in 1 2 3 4 5 6; do   # el instance profile de IAM tarda en propagarse
  INSTANCE_ID=$(aws ec2 run-instances --region "$REGION" --image-id "$AMI" --instance-type t4g.micro \
    --iam-instance-profile Name="$ROLE" --security-group-ids "$SG_ID" \
    --metadata-options HttpTokens=required,HttpEndpoint=enabled \
    --block-device-mappings 'DeviceName=/dev/xvda,Ebs={VolumeSize=8,VolumeType=gp3,Encrypted=true}' \
    --user-data file:///tmp/techstore-userdata.sh \
    --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=techstore-web},{Key=Proyecto,Value=TechStore}]' \
    --query 'Instances[0].InstanceId' --output text) && break
  echo "  (esperando propagación de IAM, reintento $try)"; sleep 10
  done
  save INSTANCE_ID "$INSTANCE_ID"
  aws ec2 wait instance-running --region "$REGION" --instance-ids "$INSTANCE_ID"
fi
EC2_DNS=$(aws ec2 describe-instances --region "$REGION" --instance-ids "$INSTANCE_ID" --query 'Reservations[0].Instances[0].PublicDnsName' --output text)
save EC2_DNS "$EC2_DNS"
echo "  Instancia: $INSTANCE_ID ($EC2_DNS)"

if [ -z "${CF_ID:-}" ]; then
  echo "» CloudFront (HTTPS)..."
  cat > /tmp/techstore-cf.json <<EOF
{
  "CallerReference": "techstore-$(date +%s)",
  "Comment": "TechStore - HTTPS delante de EC2",
  "Enabled": true,
  "PriceClass": "PriceClass_100",
  "Origins": {"Quantity": 1, "Items": [{
    "Id": "ec2-techstore", "DomainName": "$EC2_DNS",
    "CustomOriginConfig": {"HTTPPort": 3000, "HTTPSPort": 443, "OriginProtocolPolicy": "http-only"}
  }]},
  "DefaultCacheBehavior": {
    "TargetOriginId": "ec2-techstore",
    "ViewerProtocolPolicy": "redirect-to-https",
    "AllowedMethods": {"Quantity": 7, "Items": ["GET","HEAD","OPTIONS","PUT","POST","PATCH","DELETE"],
                       "CachedMethods": {"Quantity": 2, "Items": ["GET","HEAD"]}},
    "CachePolicyId": "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
    "OriginRequestPolicyId": "b689b0a8-53d0-40ab-baf2-68738e2966ac",
    "ResponseHeadersPolicyId": "67f7725c-6f97-4210-82d7-5512b31e9d03",
    "Compress": true
  }
}
EOF
  read -r CF_ID CF_DOMAIN < <(aws cloudfront create-distribution --region us-east-1 --distribution-config file:///tmp/techstore-cf.json \
    --query 'Distribution.[Id,DomainName]' --output text)
  save CF_ID "$CF_ID"; save CF_DOMAIN "$CF_DOMAIN"
fi
echo "  CloudFront: https://$CF_DOMAIN"

aws ssm put-parameter --region "$REGION" --name /techstore/BASE_URL --type String --value "https://$CF_DOMAIN" --overwrite >/dev/null
bash infra/update-client.sh   # agrega la URL https de CloudFront como callback de Cognito

echo "» Esperando a que la app arranque en EC2 y reiniciando con la URL final..."
for i in $(seq 1 40); do
  ST=$(aws ssm describe-instance-information --region "$REGION" --filters Key=InstanceIds,Values="$INSTANCE_ID" --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null || true)
  [ "$ST" = Online ] && break; sleep 10
done
aws ssm send-command --region "$REGION" --instance-ids "$INSTANCE_ID" --document-name AWS-RunShellScript \
  --parameters 'commands=["for i in $(seq 1 60); do systemctl is-active techstore && break; sleep 5; done; systemctl restart techstore"]' >/dev/null
echo "» Esperando el despliegue de CloudFront (puede tardar ~5 min)..."
aws cloudfront wait --region us-east-1 distribution-deployed --id "$CF_ID"
echo "✔ Listo: https://$CF_DOMAIN"
