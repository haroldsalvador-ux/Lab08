// Evidencia de la infraestructura en AWS obtenida con la AWS CLI (datos reales de la cuenta).
// Genera capturas en capturas-aws/aws-cli/ y el video video/demo-aws-cli.webm.
const { execFileSync } = require('child_process');
const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'capturas-aws', 'aws-cli');
const VID = path.join(ROOT, 'video');
fs.mkdirSync(OUT, { recursive: true });
const S = Object.fromEntries(fs.readFileSync(path.join(__dirname, 'infra', 'state.env'), 'utf8')
  .split('\n').filter(Boolean).map((l) => [l.split('=')[0], l.slice(l.indexOf('=') + 1)]));
const R = 'us-east-2';

function aws(args, region = R) {
  const full = [...args, '--region', region, '--output', 'json'];
  const out = execFileSync('aws', full, { encoding: 'utf8' });
  return { cmd: 'aws ' + args.map((a) => (/[\s*\[\]{}]/.test(a) ? `'${a}'` : a)).join(' '), out: JSON.parse(out) };
}

const steps = [];
const add = (name, title, desc, r, mapOut = (x) => x) => steps.push({ name, title, desc, cmd: r.cmd, out: mapOut(r.out) });

add('identidad', 'Cuenta y región', 'Sesión de la AWS CLI usada para crear y consultar los recursos (región us-east-2, Ohio).',
  aws(['sts', 'get-caller-identity']));
add('cognito-user-pool', 'Amazon Cognito · User Pool', 'Política de contraseñas, MFA obligatorio, inicio con email y atributo personalizado custom:store.',
  aws(['cognito-idp', 'describe-user-pool', '--user-pool-id', S.POOL_ID, '--query',
    'UserPool.{Id:Id,Nombre:Name,PoliticaContrasena:Policies.PasswordPolicy,MFA:MfaConfiguration,Login:UsernameAttributes,Usuarios:EstimatedNumberOfUsers,Dominio:Domain,AtributoTienda:SchemaAttributes[?Name==`custom:store`]|[0].{Nombre:Name,Tipo:AttributeDataType}}']));
add('cognito-mfa', 'Amazon Cognito · MFA TOTP', 'MFA "ON" (obligatorio) con token de software TOTP: Google Authenticator, 6 dígitos cada 30 s.',
  aws(['cognito-idp', 'get-user-pool-mfa-config', '--user-pool-id', S.POOL_ID]));
add('cognito-grupos', 'Amazon Cognito · Grupos = Roles', 'Los cuatro perfiles del caso TechStore. El grupo viaja en el JWT (claim cognito:groups).',
  aws(['cognito-idp', 'list-groups', '--user-pool-id', S.POOL_ID, '--query', 'Groups[].{Grupo:GroupName,Precedencia:Precedence,Descripcion:Description}']));
const users = aws(['cognito-idp', 'list-users', '--user-pool-id', S.POOL_ID, '--query',
  'Users[].{Email:Attributes[?Name==`email`]|[0].Value,Tienda:Attributes[?Name==`custom:store`]|[0].Value,Estado:UserStatus,Activo:Enabled}']);
for (const u of users.out) {
  const g = aws(['cognito-idp', 'admin-list-groups-for-user', '--user-pool-id', S.POOL_ID, '--username', u.Email, '--query', 'Groups[].GroupName']).out;
  u.Grupos = g;
}
add('cognito-usuarios', 'Amazon Cognito · Usuarios registrados', 'Usuarios creados desde el formulario de la app (SignUp) con su tienda y su grupo/rol.', users);
add('cognito-app-client', 'Amazon Cognito · App Client', 'Cliente web sin secreto, flujo USER_PASSWORD_AUTH, tokens de 60 min y URLs de callback (local y CloudFront).',
  aws(['cognito-idp', 'describe-user-pool-client', '--user-pool-id', S.POOL_ID, '--client-id', S.CLIENT_ID, '--query',
    'UserPoolClient.{Nombre:ClientName,Flujos:ExplicitAuthFlows,Proveedores:SupportedIdentityProviders,Callbacks:CallbackURLs,OAuth:AllowedOAuthFlows,Scopes:AllowedOAuthScopes,EvitarEnumeracion:PreventUserExistenceErrors,SesionMFA_min:AuthSessionValidity,IdToken:IdTokenValidity,Unidades:TokenValidityUnits}']));
add('ec2-instancia', 'Amazon EC2 · Servidor de la aplicación', 'Amazon Linux 2023 ARM (t4g.micro), IMDSv2 obligatorio, disco EBS cifrado y rol IAM; sin par de claves SSH.',
  aws(['ec2', 'describe-instances', '--instance-ids', S.INSTANCE_ID, '--query',
    'Reservations[0].Instances[0].{Id:InstanceId,Tipo:InstanceType,Estado:State.Name,AMI:ImageId,Arquitectura:Architecture,DNS:PublicDnsName,IMDSv2:MetadataOptions.HttpTokens,RolIAM:IamInstanceProfile.Arn,ClaveSSH:KeyName,SecurityGroups:SecurityGroups[].GroupName,Nombre:Tags[?Key==`Name`]|[0].Value}']));
const vol = aws(['ec2', 'describe-volumes', '--filters', `Name=attachment.instance-id,Values=${S.INSTANCE_ID}`, '--query', 'Volumes[].{Volumen:VolumeId,GiB:Size,Tipo:VolumeType,Cifrado:Encrypted,KMS:KmsKeyId}']);
add('ec2-ebs-cifrado', 'Amazon EBS · Disco cifrado', 'El volumen raíz de la instancia está cifrado con AWS KMS.', vol);
add('ec2-security-group', 'Security Group · Firewall', 'Solo se permite el puerto 3000 desde la lista de IPs de CloudFront (prefix list administrada). No hay puerto 22 abierto.',
  aws(['ec2', 'describe-security-groups', '--group-ids', S.SG_ID, '--query',
    'SecurityGroups[0].{Grupo:GroupName,Descripcion:Description,Entrada:IpPermissions[].{Protocolo:IpProtocol,Puerto:FromPort,Origen:PrefixListIds[].[PrefixListId,Description]}}']));
add('iam-rol', 'AWS IAM · Rol de la instancia (mínimo privilegio)', 'La app usa credenciales temporales del rol: solo puede leer su artefacto en S3, sus parámetros y administrar grupos de su User Pool.',
  aws(['iam', 'get-role-policy', '--role-name', 'techstore-ec2-role', '--policy-name', 'techstore-app', '--query', 'PolicyDocument.Statement']));
add('iam-politicas-adjuntas', 'AWS IAM · Políticas administradas', 'AmazonSSMManagedInstanceCore permite administrar la instancia con Systems Manager sin abrir SSH.',
  aws(['iam', 'list-attached-role-policies', '--role-name', 'techstore-ec2-role']));
add('s3-bloqueo-publico', 'Amazon S3 · Bucket de despliegue', 'El código se sube a un bucket privado con todo el acceso público bloqueado.',
  aws(['s3api', 'get-public-access-block', '--bucket', S.BUCKET]));
add('s3-objetos', 'Amazon S3 · Artefacto', 'Paquete de la aplicación que la instancia descarga al arrancar.',
  aws(['s3api', 'list-objects-v2', '--bucket', S.BUCKET, '--query', 'Contents[].{Archivo:Key,Bytes:Size,Fecha:LastModified,Cifrado:StorageClass}']));
add('ssm-parameter-store', 'SSM Parameter Store · Configuración y secretos', 'JWT_SECRET guardado como SecureString (cifrado con KMS). El valor nunca se escribe en el código ni en el disco del repositorio.',
  aws(['ssm', 'describe-parameters', '--parameter-filters', 'Key=Name,Option=BeginsWith,Values=/techstore', '--query', 'Parameters[].{Nombre:Name,Tipo:Type,ClaveKMS:KeyId}']));
add('cloudfront', 'Amazon CloudFront · HTTPS', 'Distribución delante de EC2: redirige HTTP→HTTPS, sin caché para la API y con cabeceras de seguridad (HSTS, X-Frame-Options…).',
  aws(['cloudfront', 'get-distribution', '--id', S.CF_ID, '--query',
    'Distribution.{Id:Id,Dominio:DomainName,Estado:Status,Origen:DistributionConfig.Origins.Items[0].DomainName,PuertoOrigen:DistributionConfig.Origins.Items[0].CustomOriginConfig.HTTPPort,PoliticaVisor:DistributionConfig.DefaultCacheBehavior.ViewerProtocolPolicy,PoliticaCabecerasSeguridad:DistributionConfig.DefaultCacheBehavior.ResponseHeadersPolicyId}'], 'us-east-1'));
const headers = execFileSync('curl', ['-sI', `https://${S.CF_DOMAIN}/`], { encoding: 'utf8' })
  .split('\r\n').filter((h) => /^(HTTP|strict-transport|x-frame|x-content|referrer|x-xss|via|x-cache)/i.test(h));
steps.push({ name: 'https-cabeceras', title: 'HTTPS · Cabeceras de seguridad', desc: 'Respuesta real de la app publicada en CloudFront.',
  cmd: `curl -sI https://${S.CF_DOMAIN}/`, out: headers });
add('cloudtrail-cognito', 'AWS CloudTrail · Auditoría', 'CloudTrail registra cada llamada a la API de Cognito: quién, cuándo y qué (trazabilidad / no repudio).',
  aws(['cloudtrail', 'lookup-events', '--max-results', '15', '--lookup-attributes', 'AttributeKey=EventSource,AttributeValue=cognito-idp.amazonaws.com',
    '--query', 'Events[].{Fecha:EventTime,Evento:EventName,Usuario:Username}']));

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
// JSON con colores
const color = (o) => esc(JSON.stringify(o, null, 2))
  .replace(/(&quot;|")([^"\n]+)("):/g, '<span class="k">"$2"</span>:')
  .replace(/: "([^"\n]*)"/g, ': <span class="s">"$1"</span>')
  .replace(/: (true|false|null|-?\d+(?:\.\d+)?)/g, ': <span class="n">$1</span>');
const page = (st, i) => `<!doctype html><meta charset="utf-8"><style>
  body{margin:0;background:#0f172a;font-family:-apple-system,Segoe UI,sans-serif;color:#e2e8f0}
  .bar{background:#232f3e;padding:14px 26px;display:flex;align-items:center;gap:14px;border-bottom:3px solid #ff9900}
  .bar b{color:#ff9900;font-size:20px}.bar span{color:#cbd5e1;font-size:14px;margin-left:auto}
  .wrap{padding:22px 26px}.desc{color:#cbd5e1;font-size:15px;margin:0 0 14px}
  .term{background:#020617;border:1px solid #334155;border-radius:10px;overflow:hidden}
  .term .t{background:#1e293b;padding:8px 12px;font-size:12px;color:#94a3b8}
  .term .t i{display:inline-block;width:11px;height:11px;border-radius:50%;margin-right:6px}
  pre{margin:0;padding:14px 16px;font:13px/1.45 ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-all}
  .p{color:#22c55e}.k{color:#7dd3fc}.s{color:#fde68a}.n{color:#f0abfc}</style>
  <div class="bar"><b>AWS</b><div style="font-size:19px;font-weight:700">${esc(st.title)}</div><span>TechStore · us-east-2 · ${i + 1}/${steps.length}</span></div>
  <div class="wrap"><p class="desc">${esc(st.desc)}</p><div class="term">
  <div class="t"><i style="background:#ef4444"></i><i style="background:#f59e0b"></i><i style="background:#22c55e"></i> Terminal — AWS CLI</div>
  <pre><span class="p">$</span> ${esc(st.cmd)}\n\n${Array.isArray(st.out) && typeof st.out[0] === 'string' ? esc(st.out.join('\n')) : color(st.out)}</pre></div></div>`;

(async () => {
  // HTML_DIR=... solo exporta las páginas (las usa video-demo.js), sin grabar ni capturar.
  if (process.env.HTML_DIR) {
    fs.mkdirSync(process.env.HTML_DIR, { recursive: true });
    steps.forEach((st, i) => fs.writeFileSync(path.join(process.env.HTML_DIR, `${String(i + 1).padStart(2, '0')}-${st.name}.html`), page(st, i)));
    return console.log('✔ páginas exportadas en', process.env.HTML_DIR);
  }
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir: VID, size: { width: 1280, height: 800 } } });
  const p = await ctx.newPage();
  for (const [i, st] of steps.entries()) {
    await p.setContent(page(st, i));
    await p.screenshot({ path: path.join(OUT, `${String(i + 1).padStart(2, '0')}-${st.name}.png`), fullPage: true });
    console.log('✔', st.name);
    await p.waitForTimeout(4500);
  }
  await ctx.close();
  fs.renameSync(await p.video().path(), path.join(VID, 'demo-aws-cli.webm'));
  console.log('🎬 video/demo-aws-cli.webm');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
