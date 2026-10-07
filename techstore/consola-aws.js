// Abre la consola de AWS en una ventana de Chrome: el usuario inicia sesión y el script
// recorre los servicios usados, toma capturas y graba el video (solo después del login).
const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'capturas-aws', 'consola');
const VID = path.join(ROOT, 'video');
fs.mkdirSync(OUT, { recursive: true });
const S = Object.fromEntries(fs.readFileSync(path.join(__dirname, 'infra', 'state.env'), 'utf8')
  .split('\n').filter(Boolean).map((l) => [l.split('=')[0], l.slice(l.indexOf('=') + 1)]));
const R = 'us-east-2';
const PROFILE = process.env.PROFILE_DIR || path.join(require('os').tmpdir(), 'techstore-aws-console');

const c = (svc, frag = '') => `https://${R}.console.aws.amazon.com/${svc}?region=${R}${frag}`;
const pool = `https://${R}.console.aws.amazon.com/cognito/v2/idp/user-pools/${S.POOL_ID}`;
const PAGES = [
  ['cognito-user-pool', `${pool}/overview?region=${R}`, 'Amazon Cognito: User Pool de TechStore'],
  ['cognito-usuarios', `${pool}/user-management/users?region=${R}`, 'Cognito: usuarios registrados desde la app'],
  ['cognito-grupos-roles', `${pool}/user-management/groups?region=${R}`, 'Cognito: grupos = roles (ADMIN, GERENTE, EMPLEADO, AUDITOR)'],
  ['cognito-politica-contrasena-mfa', `${pool}/authentication/sign-in?region=${R}`, 'Cognito: política de contraseñas y MFA obligatorio (TOTP)'],
  ['cognito-proveedores-sociales', `${pool}/authentication/social?region=${R}`, 'Cognito: proveedores de identidad (Google)'],
  ['cognito-app-client', `${pool}/applications/app-clients?region=${R}`, 'Cognito: App Client de la aplicación web'],
  ['ec2-instancia', c('ec2/home', `#InstanceDetails:instanceId=${S.INSTANCE_ID}`), 'Amazon EC2: servidor de la aplicación (Amazon Linux 2023)'],
  ['ec2-security-group', c('ec2/home', `#SecurityGroup:groupId=${S.SG_ID}`), 'Security Group: puerto 3000 abierto solo para CloudFront'],
  ['iam-rol-ec2', 'https://us-east-1.console.aws.amazon.com/iam/home#/roles/details/techstore-ec2-role?section=permissions', 'AWS IAM: rol de la instancia con mínimo privilegio'],
  ['s3-bucket-despliegue', c(`s3/buckets/${S.BUCKET || ''}`), 'Amazon S3: artefacto de despliegue (acceso público bloqueado)'],
  ['ssm-parameter-store', c('systems-manager/parameters'), 'SSM Parameter Store: configuración y JWT_SECRET cifrado con KMS'],
  ['cloudfront-distribucion', `https://us-east-1.console.aws.amazon.com/cloudfront/v4/home#/distributions/${S.CF_ID}`, 'Amazon CloudFront: HTTPS delante de EC2'],
  ['cloudtrail-eventos-cognito', c('cloudtrail/home', '#/events?EventSource=cognito-idp.amazonaws.com'), 'AWS CloudTrail: auditoría de llamadas a Cognito'],
];

(async () => {
  // 1) Ventana visible para que el usuario inicie sesión (no se graba).
  const login = await chromium.launchPersistentContext(PROFILE, { channel: 'chrome', headless: false, viewport: null });
  const lp = login.pages()[0] || await login.newPage();
  await lp.goto(`https://${R}.console.aws.amazon.com/console/home?region=${R}`);
  console.log('» Inicia sesión en la consola de AWS en la ventana de Chrome que se abrió...');
  // El portal de la organización puede abrir la consola en otra pestaña: se vigilan todas.
  const inConsole = (u) => /console\.aws\.amazon\.com\//.test(u) && !/signin|oauth|federation/.test(u);
  const deadline = Date.now() + 20 * 60000;
  while (!login.pages().some((p) => inConsole(p.url()))) {
    if (Date.now() > deadline) throw new Error('No se detectó el inicio de sesión en la consola');
    if (!login.pages().length) throw new Error('Se cerró la ventana de Chrome');
    await new Promise((r) => setTimeout(r, 1500));
    if (Date.now() % 15000 < 1500) console.log('  … página actual:', login.pages().map((p) => p.url().split('?')[0]).join(' | '));
  }
  await new Promise((r) => setTimeout(r, 5000));
  const state = await login.storageState();
  await login.close();
  console.log('✔ Sesión detectada. Grabando recorrido por la consola...');

  // 2) Recorrido grabado con la sesión ya iniciada.
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({
    storageState: state, viewport: { width: 1440, height: 900 },
    recordVideo: { dir: VID, size: { width: 1440, height: 900 } },
  });
  const page = await ctx.newPage();
  let n = 0;
  for (const [name, url, label] of PAGES) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(4000);
      if (process.env.ROTULOS) await page.evaluate((t) => {
        const el = document.createElement('div');
        el.id = '__cap';
        el.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:rgba(35,47,62,.95);color:#fff;' +
          'font:600 18px -apple-system,Segoe UI,sans-serif;padding:14px 24px;border-top:4px solid #ff9900;text-align:center';
        el.textContent = t;
        document.body.appendChild(el);
      }, label);
      await page.waitForTimeout(2500);
      await page.evaluate(() => { const c = document.getElementById('__cap'); if (c) c.style.display = 'none'; });
      await page.screenshot({ path: path.join(OUT, `${String(++n).padStart(2, '0')}-${name}.png`) });
      await page.evaluate(() => { const c = document.getElementById('__cap'); if (c) c.remove(); });
      console.log('✔', name);
    } catch (e) {
      console.log('✖', name, e.message.split('\n')[0]);
    }
  }
  await ctx.close();
  fs.renameSync(await page.video().path(), path.join(VID, 'demo-consola-aws.webm'));
  console.log('🎬 video/demo-consola-aws.webm');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
