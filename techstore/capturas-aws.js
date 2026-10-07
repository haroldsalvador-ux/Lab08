// Capturas + video de la demo con Amazon Cognito (local o desplegado en AWS).
// Uso: BASE=https://xxxx.cloudfront.net node capturas-aws.js
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { chromium } = require('playwright-core');
const { authenticator } = require('otplib');
const path = require('path');
const fs = require('fs');

const BASE = process.env.BASE || 'http://localhost:3000';
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'capturas-aws');
const VID = path.join(ROOT, 'video');
const SECRETS = path.join(__dirname, 'infra', '.totp-prueba.json'); // secretos TOTP de usuarios de prueba
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(VID, { recursive: true });
const secrets = fs.existsSync(SECRETS) ? JSON.parse(fs.readFileSync(SECRETS)) : {};
const saveSecrets = () => fs.writeFileSync(SECRETS, JSON.stringify(secrets, null, 2));

const RUN = Date.now().toString(36).slice(-4); // sufijo para que cada ejecución registre usuarios nuevos
const PASS = 'Tienda#2026';
const ADMIN = { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD };
const U = {
  gerente: `gerente.lima.${RUN}@techstore.pe`,
  empleado: `empleado.lima.${RUN}@techstore.pe`,
  auditor: `auditor.${RUN}@techstore.pe`,
  bloqueo: `prueba.bloqueo.${RUN}@techstore.pe`,
};

let n = 0;
let page;
const pause = (ms = 1200) => page.waitForTimeout(ms);

// Rótulo explicativo para el video (se oculta en las capturas)
async function caption(text) {
  if (!process.env.ROTULOS) return pause(1200); // video simple: sin rótulos
  await page.evaluate((t) => {
    let el = document.getElementById('__cap');
    if (!el) {
      el = document.createElement('div');
      el.id = '__cap';
      el.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99999;background:rgba(35,47,62,.95);color:#fff;' +
        'font:600 18px -apple-system,Segoe UI,sans-serif;padding:14px 24px;border-top:4px solid #ff9900;text-align:center';
      document.body.appendChild(el);
    }
    el.textContent = t;
  }, text);
  await pause(1600);
}
async function shot(name, opts = {}) {
  await page.evaluate(() => { const c = document.getElementById('__cap'); if (c) c.style.display = 'none'; });
  const file = path.join(OUT, `${String(++n).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file, fullPage: true, ...opts });
  await page.evaluate(() => { const c = document.getElementById('__cap'); if (c) c.style.display = ''; });
  console.log('✔', path.basename(file));
}
async function api(method, url, token, body) {
  const r = await fetch(BASE + url, {
    method, headers: { 'content-type': 'application/json', ...(token && { authorization: 'Bearer ' + token }) },
    body: body && JSON.stringify(body),
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
// Cognito no acepta reutilizar un código TOTP: si el código actual ya se usó, esperar al siguiente.
const usedCodes = new Set();
async function totp(email) {
  let code = authenticator.generate(secrets[email]);
  while (usedCodes.has(email + code)) { await page.waitForTimeout(2000); code = authenticator.generate(secrets[email]); }
  usedCodes.add(email + code);
  return code;
}

async function typeLogin(email, password) {
  await page.goto(BASE + '/');
  await page.fill('#email', email);
  await page.fill('#password', password);
}

async function login(email, password, { label, capture } = {}) {
  await typeLogin(email, password);
  if (label) await caption(label);
  await page.click('button[type=submit]');
  await page.waitForURL(/mfa\.html/);
  await page.waitForTimeout(800);
  if (await page.isVisible('#setup')) {
    await page.waitForSelector('#qr[src^="data:"]');
    secrets[email] = (await page.textContent('#secret')).trim();
    saveSecrets();
    if (capture?.setup) { await caption('Amazon Cognito genera el secreto TOTP → QR para Google Authenticator'); await shot(capture.setup); }
  }
  if (capture?.bad) {
    await page.fill('#code', '000000');
    await page.click('button[type=submit]');
    await page.waitForSelector('#msg.err');
    await caption('Código MFA incorrecto: el sistema descuenta intentos (máximo 3)');
    await shot(capture.bad);
  }
  await page.fill('#code', await totp(email));
  await caption('Código de 6 dígitos de la app autenticadora (cambia cada 30 s)');
  if (capture?.code) await shot(capture.code);
  await page.click('button[type=submit]');
  await page.waitForURL(/dashboard\.html/, { timeout: 20000 });
  await page.waitForLoadState('networkidle');
  return page.evaluate(() => sessionStorage.getItem('token'));
}
async function logout() {
  await page.click('#logout');
  await page.waitForURL((u) => !u.pathname.includes('dashboard'));
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 }, locale: 'es-PE',
    recordVideo: { dir: VID, size: { width: 1280, height: 800 } },
  });
  page = await ctx.newPage();

  // ---------- Registro ----------
  await page.goto(BASE + '/');
  await caption(`Aplicación publicada: ${BASE}`);
  await shot('login-cognito');

  await page.goto(BASE + '/register.html');
  await page.fill('#fullName', 'Gerente Lima Centro');
  await page.fill('#email', U.gerente);
  await page.type('#password', 'clave123', { delay: 80 });
  await caption('Registro: la contraseña debe tener 8+ caracteres, mayúscula, número y símbolo');
  await page.click('button[type=submit]');
  await page.waitForSelector('#msg.err');
  await caption('Contraseña débil rechazada');
  await shot('registro-contrasena-debil');
  await page.fill('#password', '');
  await page.type('#password', PASS, { delay: 80 });
  await page.selectOption('#store', 'Lima Centro');
  await page.click('button[type=submit]');
  await page.waitForSelector('#msg.ok');
  await caption('Usuario creado en el User Pool de Amazon Cognito (rol inicial EMPLEADO)');
  await shot('registro-exitoso-cognito');
  await page.click('button[type=submit]');
  await page.waitForSelector('#msg.err');
  await caption('Email único: un segundo registro con el mismo correo es rechazado');
  await shot('registro-email-duplicado');

  for (const [k, name, store] of [['empleado', 'Empleado Ventas Lima', 'Lima Centro'], ['auditor', 'Auditor Interno', 'Central'], ['bloqueo', 'Usuario Prueba Bloqueo', 'Arequipa']])
    await api('POST', '/api/auth/register', null, { email: U[k], password: PASS, fullName: name, store });

  // ---------- Bloqueo tras 5 intentos ----------
  await typeLogin(U.bloqueo, 'Incorrecta#1');
  await caption('Login con contraseña incorrecta (Cognito valida las credenciales)');
  for (let i = 1; i <= 5; i++) {
    await page.fill('#password', 'Incorrecta#' + i);
    await Promise.all([page.waitForResponse('**/api/auth/login'), page.click('button[type=submit]')]);
    await page.waitForTimeout(400);
    if (i === 1) { await caption('Intento fallido 1: quedan 4 intentos'); await shot('login-intento-fallido'); }
  }
  await caption('5.º intento fallido: cuenta bloqueada 15 minutos');
  await shot('login-cuenta-bloqueada');
  await page.fill('#password', PASS);
  await Promise.all([page.waitForResponse('**/api/auth/login'), page.click('button[type=submit]')]);
  await page.waitForTimeout(400);
  await caption('Aun con la contraseña correcta, la cuenta sigue bloqueada');
  await shot('login-bloqueada-clave-correcta');

  // ---------- MFA administrador ----------
  const adminToken = await login(ADMIN.email, ADMIN.password, {
    label: 'Administrador: credenciales correctas → Cognito exige el segundo factor',
    capture: { setup: 'mfa-qr-cognito', bad: 'mfa-codigo-incorrecto', code: 'mfa-codigo-correcto' },
  });
  // El admin asigna roles (grupos de Cognito)
  const users = (await api('GET', '/api/admin/users', adminToken)).data;
  const id = (e) => users.find((u) => u.email === e)?.id;
  await api('PATCH', `/api/admin/users/${id(U.gerente)}`, adminToken, { role: 'GERENTE' });
  await api('PATCH', `/api/admin/users/${id(U.auditor)}`, adminToken, { role: 'AUDITOR' });
  await page.reload(); await page.waitForLoadState('networkidle');
  await caption('Administrador: acceso total. El token JWT lo emitió Amazon Cognito');
  await shot('dashboard-admin');
  await page.locator('#usrSec').scrollIntoViewIfNeeded();
  await caption('Gestión de usuarios: roles = grupos de Cognito, estado MFA y cuenta bloqueada');
  await page.locator('#usrSec').screenshot({ path: path.join(OUT, `${String(++n).padStart(2, '0')}-admin-usuarios-roles.png`) });
  await logout();

  // ---------- MFA: 3 intentos ----------
  await typeLogin(ADMIN.email, ADMIN.password);
  await page.click('button[type=submit]');
  await page.waitForURL(/mfa\.html/);
  for (const c of ['111111', '222222', '333333']) {
    await page.fill('#code', c);
    await Promise.all([page.waitForResponse('**/mfa/verify'), page.click('button[type=submit]')]);
    await page.waitForTimeout(500);
  }
  await caption('Tres códigos MFA incorrectos: la sesión se invalida');
  await shot('mfa-3-intentos-agotados');

  // ---------- Gerente ----------
  await login(U.gerente, PASS, { label: 'Gerente de Tienda (Lima Centro)', capture: { setup: 'mfa-qr-cognito-primer-ingreso' } });
  await page.fill('input[id^="pr-"]', '3199.90');
  await page.click('td button >> nth=0');
  await page.waitForSelector('#pmsg.ok');
  await caption('Gerente: solo ve su tienda y puede modificar precios');
  await shot('dashboard-gerente');
  const gerenteToken = await page.evaluate(() => sessionStorage.getItem('token'));
  await logout();

  // ---------- Empleado ----------
  await login(U.empleado, PASS, { label: 'Empleado de Ventas' });
  await page.fill('input[id^="pr-"]', '1.00');
  await page.click('td button >> nth=0');
  await page.waitForSelector('#pmsg.err');
  await caption('Empleado: NO puede modificar precios → HTTP 403');
  await shot('empleado-precio-403');
  await page.fill('input[id^="st-"]', '9');
  await page.click('td button >> nth=1');
  await page.waitForSelector('#pmsg.ok');
  await caption('Empleado: SÍ puede actualizar el stock');
  await shot('empleado-stock-ok');
  const empleadoToken = await page.evaluate(() => sessionStorage.getItem('token'));
  await logout();

  // ---------- Auditor ----------
  await login(U.auditor, PASS, { label: 'Auditor' });
  await page.fill('input[id^="st-"]', '99');
  await page.click('td button >> nth=1');
  await page.waitForSelector('#pmsg.err');
  await caption('Auditor: solo lectura de todo; cualquier modificación → HTTP 403');
  await shot('auditor-403');
  await page.locator('#audSec').scrollIntoViewIfNeeded();
  await caption('Bitácora de auditoría: todos los eventos de seguridad');
  await page.locator('#audSec').screenshot({ path: path.join(OUT, `${String(++n).padStart(2, '0')}-bitacora-auditoria.png`) });
  await logout();

  // ---------- Evidencia: JWT de Cognito y pruebas de API ----------
  const parts = adminToken.split('.');
  const dec = (s) => JSON.parse(Buffer.from(s, 'base64url').toString());
  const header = dec(parts[0]);
  const payload = dec(parts[1]);
  const products = (await api('GET', '/api/products', adminToken)).data;
  const other = products.find((p) => p.store === 'Arequipa');
  const pending = await api('POST', '/api/auth/login', null, { email: U.auditor, password: PASS });
  const forge = (t) => { const [h, p, sg] = t.split('.'); return h + '.' + Buffer.from(JSON.stringify({ ...dec(p), 'cognito:groups': ['ADMIN'] })).toString('base64url') + '.' + sg; };
  const tests = [
    ['Sin token', 'GET', '/api/products', null],
    ['Token MFA pendiente (sin 2.º factor)', 'GET', '/api/products', pending.data.mfaToken],
    ['Token de Empleado alterado para ser ADMIN (firma inválida)', 'GET', '/api/admin/users', forge(empleadoToken)],
    ['Gerente Lima elimina producto de Arequipa', 'DELETE', `/api/products/${other.id}`, gerenteToken],
    ['Empleado intenta cambiar su rol a ADMIN', 'PATCH', `/api/admin/users/${id(U.empleado)}`, empleadoToken, { role: 'ADMIN' }],
    ['Gerente consulta reportes (solo su tienda)', 'GET', '/api/reports', gerenteToken],
  ];
  const results = [];
  for (const [label, m, u, t, b] of tests) results.push({ label, line: `${m} ${u}`, ...(await api(m, u, t, b)) });

  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const css = `body{font-family:-apple-system,Segoe UI,sans-serif;background:#0f172a;color:#e2e8f0;padding:24px;margin:0}
    h1{font-size:20px;margin:0 0 16px;color:#ff9900} .box{background:#1e293b;border-radius:10px;padding:14px 18px;margin-bottom:12px}
    pre{margin:6px 0 0;white-space:pre-wrap;word-break:break-all;font:12.5px ui-monospace,Menlo,monospace}
    .s{display:inline-block;padding:2px 8px;border-radius:6px;font-weight:700;margin-left:8px} .ok{background:#166534} .no{background:#991b1b}
    .h{color:#f472b6}.p{color:#a78bfa}.g{color:#22d3ee}`;
  const shown = { ...payload, auth_time: undefined, origin_jti: undefined, event_id: undefined, jti: undefined };
  await page.setContent(`<style>${css}</style><h1>ID Token JWT emitido por Amazon Cognito después del MFA</h1>
    <div class="box"><b>Token codificado (firmado RS256 por AWS)</b><pre><span class="h">${parts[0]}</span>.<span class="p">${parts[1].slice(0, 260)}…</span>.<span class="g">${parts[2].slice(0, 80)}…</span></pre></div>
    <div class="box"><b class="h">Header</b><pre>${esc(JSON.stringify(header, null, 2))}</pre></div>
    <div class="box"><b class="p">Payload</b><pre>${esc(JSON.stringify({ ...shown, iat_fecha: new Date(payload.iat * 1000).toISOString(), exp_fecha: new Date(payload.exp * 1000).toISOString() }, null, 2))}</pre></div>
    <div class="box"><b class="g">Verificación</b><pre>La API valida la firma con las claves públicas (JWKS) del User Pool:\n${esc(payload.iss)}/.well-known/jwks.json</pre></div>`);
  await caption('El token incluye el rol (cognito:groups) y la tienda (custom:store)');
  await shot('jwt-cognito-decodificado');
  await page.setContent(`<style>${css}</style><h1>Pruebas de control de acceso sobre la API en AWS (respuestas reales)</h1>` +
    results.map((t) => `<div class="box"><b>${esc(t.label)}</b><span class="s ${t.status < 300 ? 'ok' : 'no'}">HTTP ${t.status}</span><pre>${esc(t.line)}\n${esc(JSON.stringify(t.data))}</pre></div>`).join(''));
  await caption('Las acciones no autorizadas son rechazadas por el servidor (401 / 403)');
  await shot('api-pruebas-acceso');

  await ctx.close(); // guarda el video
  const v = await page.video().path();
  const dest = path.join(VID, 'demo-app.webm');
  fs.renameSync(v, dest);
  console.log('🎬', dest);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
