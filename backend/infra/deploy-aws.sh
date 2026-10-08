#!/usr/bin/env bash
# Publica el backend de TechStore en AWS (región us-east-2):
#   S3 (código) -> EC2 Amazon Linux 2023 (rol IAM, IMDSv2, disco cifrado, sin SSH)
#   SSM Parameter Store (variables y secretos cifrados con KMS) -> CloudFront (HTTPS)
# Se puede ejecutar varias veces: reutiliza lo que ya existe y solo actualiza el código.
set -euo pipefail
cd "$(dirname "$0")/.."
export AWS_REGION=us-east-2
R=$AWS_REGION
STATE=infra/state.env
touch "$STATE"; source "$STATE"
save() { grep -v "^$1=" "$STATE" > "$STATE.tmp" || true; echo "$1=$2" >> "$STATE.tmp"; mv "$STATE.tmp" "$STATE"; }
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
BUCKET="techstore-api-$ACCOUNT-$R"
ROLE=techstore-api-role
APP_PORT=4000

echo "» 1/6 Subiendo el código a S3 ($BUCKET)"
if ! aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  aws s3api create-bucket --bucket "$BUCKET" --create-bucket-configuration LocationConstraint=$R >/dev/null
  aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
fi
rm -f /tmp/techstore-api.zip
zip -qr /tmp/techstore-api.zip src public scripts package.json package-lock.json
aws s3 cp /tmp/techstore-api.zip "s3://$BUCKET/techstore-api.zip" >/dev/null

echo "» 2/6 Rol IAM de la instancia (mínimo privilegio)"
if ! aws iam get-role --role-name $ROLE >/dev/null 2>&1; then
  aws iam create-role --role-name $ROLE --assume-role-policy-document \
    '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  aws iam attach-role-policy --role-name $ROLE --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
  aws iam create-instance-profile --instance-profile-name $ROLE >/dev/null
  aws iam add-role-to-instance-profile --instance-profile-name $ROLE --role-name $ROLE
fi
aws iam put-role-policy --role-name $ROLE --policy-name techstore-api --policy-document "{
  \"Version\":\"2012-10-17\",\"Statement\":[
   {\"Effect\":\"Allow\",\"Action\":\"s3:GetObject\",\"Resource\":\"arn:aws:s3:::$BUCKET/*\"},
   {\"Effect\":\"Allow\",\"Action\":[\"ssm:GetParametersByPath\",\"ssm:GetParameter\"],\"Resource\":\"arn:aws:ssm:$R:$ACCOUNT:parameter/techstore-api*\"}]}"

echo "» 3/6 Security Group (solo tráfico de CloudFront al puerto $APP_PORT)"
if [ -z "${SG_ID:-}" ]; then
  VPC=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)
  SG_ID=$(aws ec2 create-security-group --group-name techstore-api-sg --vpc-id "$VPC" \
    --description "TechStore API: solo CloudFront" --query GroupId --output text)
  PL=$(aws ec2 describe-managed-prefix-lists --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing \
    --query 'PrefixLists[0].PrefixListId' --output text)
  aws ec2 authorize-security-group-ingress --group-id "$SG_ID" \
    --ip-permissions "IpProtocol=tcp,FromPort=$APP_PORT,ToPort=$APP_PORT,PrefixListIds=[{PrefixListId=$PL,Description=CloudFront}]" >/dev/null
  save SG_ID "$SG_ID"
fi

echo "» 4/6 Instancia EC2"
if [ -z "${INSTANCE_ID:-}" ]; then
  AMI=$(aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64 --query Parameter.Value --output text)
  cat > /tmp/techstore-api-userdata.sh <<EOF
#!/bin/bash
set -eux
dnf install -y unzip tar xz
curl -fsSL https://nodejs.org/dist/v24.11.1/node-v24.11.1-linux-arm64.tar.xz | tar -xJ -C /opt
ln -sf /opt/node-v24.11.1-linux-arm64/bin/node /usr/local/bin/node
ln -sf /opt/node-v24.11.1-linux-arm64/bin/npm /usr/local/bin/npm
useradd -r -m -d /opt/techstore-api techstore || true
cat > /opt/techstore-api/update.sh <<'EOS'
#!/bin/bash
# Descarga la última versión del código desde S3 e instala dependencias
set -e
aws s3 cp s3://$BUCKET/techstore-api.zip /tmp/techstore-api.zip --region $R
unzip -o /tmp/techstore-api.zip -d /opt/techstore-api >/dev/null
cd /opt/techstore-api && /usr/local/bin/npm ci --omit=dev
chown -R techstore:techstore /opt/techstore-api
EOS
cat > /opt/techstore-api/load-env.sh <<'EOS'
#!/bin/bash
# Variables y secretos desde SSM Parameter Store (descifrados con KMS)
aws ssm get-parameters-by-path --region $R --path /techstore-api --with-decryption \
  --query 'Parameters[].[Name,Value]' --output text | sed 's#^/techstore-api/##; s#\t#=#' > /opt/techstore-api/.env
echo "PORT=$APP_PORT" >> /opt/techstore-api/.env
EOS
chmod +x /opt/techstore-api/*.sh
/opt/techstore-api/update.sh
cat > /etc/systemd/system/techstore-api.service <<'EOS'
[Unit]
Description=TechStore API
After=network-online.target
[Service]
User=techstore
WorkingDirectory=/opt/techstore-api
ExecStartPre=+/opt/techstore-api/load-env.sh
ExecStart=/usr/local/bin/node src/server.js
Restart=always
[Install]
WantedBy=multi-user.target
EOS
systemctl daemon-reload
systemctl enable --now techstore-api
EOF
  sleep 10 # propagación del rol IAM
  for try in 1 2 3 4 5 6; do
    INSTANCE_ID=$(aws ec2 run-instances --image-id "$AMI" --instance-type t4g.micro \
      --iam-instance-profile Name=$ROLE --security-group-ids "$SG_ID" \
      --metadata-options HttpTokens=required,HttpEndpoint=enabled \
      --block-device-mappings 'DeviceName=/dev/xvda,Ebs={VolumeSize=8,VolumeType=gp3,Encrypted=true}' \
      --user-data file:///tmp/techstore-api-userdata.sh \
      --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=techstore-api},{Key=Proyecto,Value=TechStore}]' \
      --query 'Instances[0].InstanceId' --output text 2>/dev/null) && break
    echo "  (esperando IAM, reintento $try)"; sleep 10
  done
  save INSTANCE_ID "$INSTANCE_ID"
  aws ec2 wait instance-running --instance-ids "$INSTANCE_ID"
fi
EC2_DNS=$(aws ec2 describe-instances --instance-ids "$INSTANCE_ID" --query 'Reservations[0].Instances[0].PublicDnsName' --output text)
echo "  $INSTANCE_ID ($EC2_DNS)"

echo "» 5/6 CloudFront (HTTPS)"
if [ -z "${CF_ID:-}" ]; then
  cat > /tmp/techstore-api-cf.json <<EOF
{ "CallerReference": "techstore-api-$(date +%s)", "Comment": "TechStore API", "Enabled": true, "PriceClass": "PriceClass_100",
  "Origins": {"Quantity": 1, "Items": [{"Id": "ec2", "DomainName": "$EC2_DNS",
    "CustomOriginConfig": {"HTTPPort": $APP_PORT, "HTTPSPort": 443, "OriginProtocolPolicy": "http-only", "OriginKeepaliveTimeout": 5}}]},
  "DefaultCacheBehavior": { "TargetOriginId": "ec2", "ViewerProtocolPolicy": "redirect-to-https",
    "AllowedMethods": {"Quantity": 7, "Items": ["GET","HEAD","OPTIONS","PUT","POST","PATCH","DELETE"],
      "CachedMethods": {"Quantity": 2, "Items": ["GET","HEAD"]}},
    "CachePolicyId": "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
    "OriginRequestPolicyId": "b689b0a8-53d0-40ab-baf2-68738e2966ac",
    "ResponseHeadersPolicyId": "67f7725c-6f97-4210-82d7-5512b31e9d03" } }
EOF
  read -r CF_ID CF_DOMAIN < <(aws cloudfront create-distribution --region us-east-1 --distribution-config file:///tmp/techstore-api-cf.json \
    --query 'Distribution.[Id,DomainName]' --output text)
  save CF_ID "$CF_ID"; save CF_DOMAIN "$CF_DOMAIN"
fi
echo "  https://$CF_DOMAIN"

echo "» 6/6 Variables en Parameter Store y reinicio de la app"
put() { aws ssm put-parameter --name "/techstore-api/$1" --type "$2" --value "$3" --overwrite >/dev/null; }
val() { grep "^$1=" .env | cut -d= -f2- | tr -d '"'; }
put BASE_URL String "https://$CF_DOMAIN"
put JWT_SECRET SecureString "$(val JWT_SECRET)"
for k in GITHUB_CLIENT_ID GOOGLE_CLIENT_ID; do [ -n "$(val $k)" ] && put $k String "$(val $k)"; done
for k in GITHUB_CLIENT_SECRET GOOGLE_CLIENT_SECRET; do [ -n "$(val $k)" ] && put $k SecureString "$(val $k)"; done
for i in $(seq 1 40); do
  ST=$(aws ssm describe-instance-information --filters Key=InstanceIds,Values="$INSTANCE_ID" --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null || true)
  [ "$ST" = Online ] && break; sleep 10
done
CMD=$(aws ssm send-command --instance-ids "$INSTANCE_ID" --document-name AWS-RunShellScript --parameters \
  'commands=["for i in $(seq 1 60); do [ -f /etc/systemd/system/techstore-api.service ] && break; sleep 5; done","/opt/techstore-api/update.sh","systemctl restart techstore-api","sleep 3","systemctl is-active techstore-api"]' \
  --query Command.CommandId --output text)
until S=$(aws ssm get-command-invocation --command-id "$CMD" --instance-id "$INSTANCE_ID" --query Status --output text 2>/dev/null) \
  && [ "$S" != Pending ] && [ "$S" != InProgress ] && [ "$S" != Delayed ]; do sleep 5; done
echo "  App en EC2: $S"
echo "✔ Listo: https://$CF_DOMAIN/api/health"
