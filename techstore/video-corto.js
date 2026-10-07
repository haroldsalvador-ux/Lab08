// Video corto: solo lo más importante, a velocidad normal.
// Video de demostración "realista": velocidad normal, cursor visible, escritura tecla por tecla.
// No toma capturas durante la grabación (las capturas de página completa encogen el video).
// Uso: BASE=https://xxxx.cloudfront.net AWS_HTML=/ruta/paginas node video-demo.js
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { chromium } = require('playwright-core');
const { authenticator } = require('otplib');
const path = require('path');
const fs = require('fs');

const BASE = process.env.BASE || 'http://localhost:3000';
const AWS_HTML = process.env.AWS_HTML; // páginas de evidencia exportadas por aws-evidencia.js
const VID = path.join(__dirname, '..', 'video');
const SECRETS = path.join(__dirname, 'infra', '.totp-prueba.json');
const secrets = fs.existsSync(SECRETS) ? JSON.parse(fs.readFileSync(SECRETS)) : {};
const RUN = Date.now().toString(36).slice(-4);
const PASS = 'Tienda#2026';
const ADMIN = { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD };
const U = {
  gerente: `gerente.lima.${RUN}@techstore.pe`,
  empleado: `empleado.lima.${RUN}@techstore.pe`,
  auditor: `auditor.${RUN}@techstore.pe`,
  bloqueo: `prueba.bloqueo.${RUN}@techstore.pe`,
};
// Partes de AWS que se muestran (las más importantes)
const AWS_PAGES = ['02-cognito-user-pool', '03-cognito-mfa', '04-cognito-grupos', '07-ec2-instancia', '15-cloudfront'];

let page;
let mouse = { x: 640, y: 400 };
const wait = (ms) => page.waitForTimeout(ms);

// Cursor dibujado en la página (el video headless no muestra el puntero real)
const CURSOR = `(() => {
  const add = () => {
    if (document.getElementById('__cursor')) return;
    const c = document.createElement('div');
    c.id = '__cursor';
    c.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M4 2l16 9.5-7 1.5-3.5 7z" fill="#111" stroke="#fff" stroke-width="1.5"/></svg>';
    c.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;left:' + (window.__mx||640) + 'px;top:' + (window.__my||400) + 'px;transition:transform .08s';
    document.documentElement.appendChild(c);
    addEventListener('mousemove', (e) => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; }, true);
    addEventListener('mousedown', () => { c.style.transform = 'scale(.8)'; }, true);
    addEventListener('mouseup', () => { c.style.transform = ''; }, true);
  };
  document.readyState === 'loading' ? addEventListener('DOMContentLoaded', add) : add();
})();`;

async function moveTo(locator) {
  await locator.scrollIntoViewIfNeeded();
  const b = await locator.boundingBox();
  const x = b.x + Math.min(b.width / 2, 60), y = b.y + b.height / 2;
  await page.mouse.move(x, y, { steps: 18 });
  mouse = { x, y };
}
async function click(sel) {
  const l = typeof sel === 'string' ? page.locator(sel).first() : sel;
  await moveTo(l);
  await wait(200);
  await l.click();
}
async function type(sel, text, delay = 55) {
  const l = page.locator(sel).first();
  await click(l);
  await l.fill('');
  await l.pressSequentially(text, { delay });
}
async function goto(url) {
  await page.goto(url);
  await page.mouse.move(mouse.x, mouse.y);
}
async function scroll(px, steps = 12) {
  for (let i = 0; i < steps; i++) { await page.mouse.wheel(0, px / steps); await wait(45); }
}
async function api(method, url, token, body) {
  const r = await fetch(BASE + url, { method, headers: { 'content-type': 'application/json', ...(token && { authorization: 'Bearer ' + token }) }, body: body && JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
const used = new Set();
async function totp(email) {
  let c = authenticator.generate(secrets[email]);
  while (used.has(email + c)) { await wait(1500); c = authenticator.generate(secrets[email]); }
  used.add(email + c);
  return c;
}
async function login(email, password) {
  await goto(BASE + '/');
  await wait(600);
  await type('#email', email, 35);
  await type('#password', password, 60);
  await click('button[type=submit]');
  await page.waitForURL(/mfa\.html/);
  await wait(1200);
  if (await page.isVisible('#setup')) {
    await page.waitForSelector('#qr[src^="data:"]');
    secrets[email] = (await page.textContent('#secret')).trim();
    fs.writeFileSync(SECRETS, JSON.stringify(secrets, null, 2));
    await moveTo(page.locator('#qr'));
    await wait(2500); // tiempo para "escanear" el QR
  }
  await type('#code', await totp(email), 140);
  await click('button[type=submit]');
  await page.waitForURL(/dashboard\.html/, { timeout: 20000 });
  await page.waitForLoadState('networkidle');
  await wait(1800);
}
async function logout() {
  await scroll(-3000, 6);
  await click('#logout');
  await page.waitForURL((u) => !u.pathname.includes('dashboard'));
  await wait(700);
}

(async () => {
  await api('POST', '/api/auth/register', null, { email: U.empleado, password: PASS, fullName: 'Empleado Ventas Lima', store: 'Lima Centro' });
  await api('POST', '/api/auth/register', null, { email: U.bloqueo, password: PASS, fullName: 'Usuario Prueba', store: 'Arequipa' });

  const browser = await chromium.launch({
    channel: 'chrome', headless: true,
    // Evita que macOS/Chrome frenen la pestaña mientras se graba
    args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'es-PE', recordVideo: { dir: VID, size: { width: 1280, height: 800 } } });
  await ctx.addInitScript(CURSOR);
  page = await ctx.newPage();
  if (process.env.DEBUG) {
    const t0 = Date.now();
    page.on('request', (r) => r.url().includes('/api/') && console.log(Date.now() - t0, 'REQ', r.method(), r.url().split('/api/')[1]));
    page.on('requestfinished', (r) => r.url().includes('/api/') && console.log(Date.now() - t0, 'FIN', r.url().split('/api/')[1]));
    page.on('requestfailed', (r) => console.log(Date.now() - t0, 'FAIL', r.url(), r.failure()?.errorText));
  }

  // 1) Registro: contraseña débil rechazada y registro correcto
  await goto(BASE + '/register.html');
  await wait(700);
  await type('#fullName', 'Gerente Lima Centro', 30);
  await type('#email', U.gerente, 25);
  await type('#password', 'clave123', 70);
  await click('button[type=submit]');
  await wait(1600);
  await type('#password', PASS, 70);
  await page.selectOption('#store', 'Lima Centro');
  await click('button[type=submit]');
  await page.waitForSelector('#msg.ok');
  await wait(1800);

  // 2) Bloqueo al 5.º intento fallido
  await goto(BASE + '/');
  await type('#email', U.bloqueo, 20);
  for (let i = 1; i <= 5; i++) {
    await type('#password', 'Incorrecta#' + i, 25);
    await Promise.all([page.waitForResponse('**/api/auth/login'), click('button[type=submit]')]);
    await wait(i === 5 ? 2200 : 500);
  }

  // 3) Administrador con MFA
  await goto(BASE + '/');
  await type('#email', ADMIN.email, 25);
  await type('#password', ADMIN.password, 40);
  await click('button[type=submit]');
  await page.waitForURL(/mfa\.html/);
  await wait(800);
  await type('#code', await totp(ADMIN.email), 100);
  await click('button[type=submit]');
  await page.waitForURL(/dashboard\.html/);
  await page.waitForLoadState('networkidle');
  await wait(2200);
  await scroll(650);
  await wait(1800);
  await logout();

  // 4) Empleado: QR de MFA (primer ingreso), precio denegado y stock permitido
  await login(U.empleado, PASS);
  await type('input[id^="pr-"]', '1.00', 90);
  await click('td button >> nth=0');
  await page.waitForSelector('#pmsg.err');
  await wait(2000);
  await type('input[id^="st-"]', '9', 90);
  await click('td button >> nth=1');
  await page.waitForSelector('#pmsg.ok');
  await wait(2000);

  // 5) AWS: lo esencial
  for (const name of AWS_PAGES) {
    await page.goto('file://' + path.join(AWS_HTML, name + '.html'));
    await page.evaluate(() => { const s = document.querySelector('.bar span'); if (s) s.textContent = 'TechStore · us-east-2'; });
    await page.mouse.move(mouse.x, mouse.y);
    await wait(3000);
  }

  await ctx.close();
  fs.renameSync(await page.video().path(), path.join(VID, 'demo-corto.webm'));
  console.log('🎬 video/demo-corto.webm');
  await browser.close();
})().catch(async (e) => { console.error(e); if (page) await page.screenshot({ path: '/tmp/vc-error.png' }).catch(() => {}); process.exit(1); });
