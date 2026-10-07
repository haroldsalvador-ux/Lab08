// Recorre los escenarios del laboratorio y guarda capturas en ../capturas
// Uso: npm start (en otra terminal)  ->  node capturas.js
require('dotenv').config();
const { chromium } = require('playwright-core');
const { authenticator } = require('otplib');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const BASE = 'http://localhost:3000';
const OUT = path.join(__dirname, '..', 'capturas');
fs.mkdirSync(OUT, { recursive: true });
const db = new DatabaseSync(path.join(__dirname, 'techstore.db'));
const PASS = 'Tienda#2026';
const ADMIN = { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD };

let n = 0;
async function shot(page, name, opts = {}) {
  const file = path.join(OUT, `${String(++n).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file, fullPage: true, ...opts });
  console.log('✔', path.basename(file));
}

async function post(url, body, token) {
  const r = await fetch(BASE + url, { method: 'POST', headers: { 'content-type': 'application/json', ...(token && { authorization: 'Bearer ' + token }) }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
}

// Login completo por la interfaz (credenciales + MFA). Si es primer ingreso, enrola el TOTP.
async function uiLogin(page, { email, password }, { capture } = {}) {
  await page.goto(BASE + '/');
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('button[type=submit]');
  await page.waitForURL(/mfa\.html/);
  await page.waitForTimeout(400);
  if (capture?.setup && (await page.isVisible('#setup'))) await shot(page, capture.setup);
  const secret = db.prepare('SELECT mfa_secret FROM users WHERE email = ?').get(email).mfa_secret;
  await page.fill('#code', authenticator.generate(secret));
  if (capture?.code) await shot(page, capture.code);
  await page.click('button[type=submit]');
  await page.waitForURL(/dashboard\.html/);
  await page.waitForLoadState('networkidle');
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'es-PE' });
  let page = await ctx.newPage();

  // ---------- PARTE 1: Registro ----------
  await page.goto(BASE + '/');
  await shot(page, 'login-pantalla-principal');

  await page.goto(BASE + '/register.html');
  await page.fill('#fullName', 'Gerente Lima Centro');
  await page.fill('#email', 'gerente.lima@techstore.pe');
  await page.fill('#password', 'clave123');
  await page.click('button[type=submit]');
  await page.waitForSelector('#msg.err');
  await shot(page, 'registro-contrasena-debil-rechazada');

  await page.fill('#password', PASS);
  await page.selectOption('#store', 'Lima Centro');
  await page.click('button[type=submit]');
  await page.waitForSelector('#msg.ok');
  await shot(page, 'registro-exitoso');

  await page.click('button[type=submit]');
  await page.waitForSelector('#msg.err');
  await shot(page, 'registro-email-duplicado');

  // Usuarios restantes por API (mismo endpoint que usa el formulario)
  await post('/api/auth/register', { email: 'empleado.lima@techstore.pe', password: PASS, fullName: 'Empleado Ventas Lima', store: 'Lima Centro' });
  await post('/api/auth/register', { email: 'auditor@techstore.pe', password: PASS, fullName: 'Auditor Interno', store: 'Central' });
  await post('/api/auth/register', { email: 'prueba.bloqueo@techstore.pe', password: PASS, fullName: 'Usuario Prueba Bloqueo', store: 'Arequipa' });

  // ---------- PARTE 1: Login fallido y bloqueo ----------
  await page.goto(BASE + '/');
  await page.fill('#email', 'prueba.bloqueo@techstore.pe');
  for (let i = 1; i <= 6; i++) {
    await page.fill('#password', 'Incorrecta#' + i);
    await Promise.all([page.waitForResponse('**/api/auth/login'), page.click('button[type=submit]')]);
    await page.waitForTimeout(150);
    if (i === 1) await shot(page, 'login-credenciales-invalidas-intento-1');
    if (i === 5) await shot(page, 'login-bloqueo-tras-5-intentos');
  }
  await page.fill('#password', PASS);
  await page.click('button[type=submit]');
  await page.waitForTimeout(400);
  await shot(page, 'login-cuenta-bloqueada-aun-con-clave-correcta');

  // ---------- PARTE 2: MFA ----------
  await page.goto(BASE + '/');
  await page.fill('#email', ADMIN.email);
  await page.fill('#password', ADMIN.password);
  await page.click('button[type=submit]');
  await page.waitForURL(/mfa\.html/);
  await page.waitForSelector('#qr[src^="data:"]');
  await shot(page, 'mfa-enrolamiento-qr-google-authenticator');

  await page.fill('#code', '000000');
  await page.click('button[type=submit]');
  await page.waitForSelector('#msg.err');
  await shot(page, 'mfa-codigo-incorrecto-intentos-restantes');

  const adminSecret = db.prepare('SELECT mfa_secret FROM users WHERE email = ?').get(ADMIN.email).mfa_secret;
  await page.fill('#code', authenticator.generate(adminSecret));
  await shot(page, 'mfa-codigo-correcto-ingresado');
  await page.click('button[type=submit]');
  await page.waitForURL(/dashboard\.html/);
  await page.waitForLoadState('networkidle');

  // JWT completo emitido tras el MFA
  const token = await page.evaluate(() => sessionStorage.getItem('token'));
  const adminToken = token;

  // ---------- Roles: el admin asigna roles ----------
  const ids = Object.fromEntries(db.prepare('SELECT email, id FROM users').all().map((u) => [u.email, u.id]));
  const patch = (id, body) => fetch(`${BASE}/api/admin/users/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + adminToken }, body: JSON.stringify(body) });
  await patch(ids['gerente.lima@techstore.pe'], { role: 'GERENTE' });
  await patch(ids['auditor@techstore.pe'], { role: 'AUDITOR' });
  await page.reload();
  await page.waitForLoadState('networkidle');
  await shot(page, 'dashboard-administrador-acceso-total');
  const adminPage = page;

  // ---------- MFA: 3 intentos máximos ----------
  const p2 = await ctx.newPage();
  await p2.goto(BASE + '/');
  await p2.fill('#email', ADMIN.email);
  await p2.fill('#password', ADMIN.password);
  await p2.click('button[type=submit]');
  await p2.waitForURL(/mfa\.html/);
  for (const c of ['111111', '222222', '333333']) {
    await p2.fill('#code', c);
    await p2.click('button[type=submit]');
    await p2.waitForTimeout(350);
  }
  await shot(p2, 'mfa-3-intentos-agotados');
  await p2.close();

  // ---------- Gerente ----------
  const ctxG = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await ctxG.newPage();
  await uiLogin(page, { email: 'gerente.lima@techstore.pe', password: PASS });
  await page.fill('input[id^="pr-"]', '3199.90');
  await page.click('td button >> nth=0');
  await page.waitForSelector('#pmsg.ok');
  await shot(page, 'dashboard-gerente-solo-su-tienda-cambia-precio');
  const gerenteToken = await page.evaluate(() => sessionStorage.getItem('token'));

  // ---------- Empleado ----------
  const ctxE = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await ctxE.newPage();
  await uiLogin(page, { email: 'empleado.lima@techstore.pe', password: PASS });
  await page.fill('input[id^="pr-"]', '1.00');
  await page.click('td button >> nth=0');
  await page.waitForSelector('#pmsg.err');
  await shot(page, 'empleado-no-puede-modificar-precios-403');
  await page.fill('input[id^="st-"]', '9');
  await page.click('td button >> nth=1');
  await page.waitForSelector('#pmsg.ok');
  await shot(page, 'empleado-actualiza-stock-ok');
  const empleadoToken = await page.evaluate(() => sessionStorage.getItem('token'));

  // ---------- Auditor ----------
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await ctxA.newPage();
  await uiLogin(page, { email: 'auditor@techstore.pe', password: PASS });
  await page.fill('input[id^="st-"]', '99');
  await page.click('td button >> nth=1');
  await page.waitForSelector('#pmsg.err');
  await shot(page, 'auditor-solo-lectura-403');

  // ---------- Evidencia API: JWT + pruebas de control de acceso ----------
  const arequipa = db.prepare(`SELECT id FROM products WHERE store = 'Arequipa' LIMIT 1`).get().id;
  const req = async (label, method, url, tk, body) => {
    const r = await fetch(BASE + url, { method, headers: { 'content-type': 'application/json', ...(tk && { authorization: 'Bearer ' + tk }) }, body: body && JSON.stringify(body) });
    return { label, line: `${method} ${url}`, status: r.status, data: await r.json() };
  };
  const pendingLogin = await post('/api/auth/login', { email: 'auditor@techstore.pe', password: PASS });
  const tests = [
    await req('Sin token', 'GET', '/api/products'),
    await req('Token MFA pendiente (sin 2º factor)', 'GET', '/api/products', pendingLogin.data.mfaToken),
    await req('Gerente Lima elimina producto de Arequipa', 'DELETE', `/api/products/${arequipa}`, gerenteToken),
    await req('Empleado intenta eliminar producto', 'DELETE', `/api/products/${arequipa}`, empleadoToken),
    await req('Empleado intenta cambiar rol', 'PATCH', `/api/admin/users/${ids['empleado.lima@techstore.pe']}`, empleadoToken, { role: 'ADMIN' }),
    await req('Gerente consulta reportes (solo su tienda)', 'GET', '/api/reports', gerenteToken),
  ];
  const decoded = jwt.decode(adminToken, { complete: true });
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const css = `body{font-family:-apple-system,Segoe UI,sans-serif;background:#0f172a;color:#e2e8f0;padding:24px;margin:0}
    h1{font-size:20px;margin:0 0 16px;color:#38bdf8} .box{background:#1e293b;border-radius:10px;padding:14px 18px;margin-bottom:12px}
    pre{margin:6px 0 0;white-space:pre-wrap;word-break:break-all;font:13px ui-monospace,Menlo,monospace}
    .s{display:inline-block;padding:2px 8px;border-radius:6px;font-weight:700;margin-left:8px} .ok{background:#166534} .no{background:#991b1b}
    .h{color:#f472b6}.p{color:#a78bfa}.g{color:#22d3ee}`;
  const jp = await ctx.newPage();
  const [h, p, s] = adminToken.split('.');
  await jp.setContent(`<style>${css}</style><h1>Token JWT completo emitido después del MFA</h1>
    <div class="box"><b>Token codificado</b><pre><span class="h">${h}</span>.<span class="p">${p}</span>.<span class="g">${s}</span></pre></div>
    <div class="box"><b class="h">Header</b><pre>${esc(JSON.stringify(decoded.header, null, 2))}</pre></div>
    <div class="box"><b class="p">Payload</b><pre>${esc(JSON.stringify({ ...decoded.payload, iat_fecha: new Date(decoded.payload.iat * 1000).toISOString(), exp_fecha: new Date(decoded.payload.exp * 1000).toISOString() }, null, 2))}</pre></div>
    <div class="box"><b class="g">Firma</b><pre>HMACSHA256(base64Url(header) + "." + base64Url(payload), JWT_SECRET)</pre></div>`);
  await shot(jp, 'jwt-token-decodificado');
  await jp.setContent(`<style>${css}</style><h1>Pruebas de control de acceso sobre la API (respuestas reales)</h1>` +
    tests.map((t) => `<div class="box"><b>${esc(t.label)}</b><span class="s ${t.status < 300 ? 'ok' : 'no'}">HTTP ${t.status}</span><pre>${esc(t.line)}\n${esc(JSON.stringify(t.data))}</pre></div>`).join(''));
  await shot(jp, 'api-pruebas-control-de-acceso');

  // ---------- Bitácora y usuarios (vista admin) ----------
  page = adminPage;
  await page.bringToFront();
  await page.reload();
  await page.waitForLoadState('networkidle');
  await page.locator('#usrSec').screenshot({ path: path.join(OUT, `${String(++n).padStart(2, '0')}-admin-usuarios-roles-bloqueo-mfa.png`) });
  console.log('✔ admin-usuarios-roles-bloqueo-mfa');
  await page.locator('#audSec').screenshot({ path: path.join(OUT, `${String(++n).padStart(2, '0')}-bitacora-auditoria.png`) });
  console.log('✔ bitacora-auditoria');

  // ---------- Login social (estado sin credenciales OAuth) ----------
  const prov = await (await fetch(BASE + '/auth/providers')).json();
  if (prov.google) {
    await page.goto(BASE + '/auth/google'); await page.waitForTimeout(1500); await shot(page, 'oauth-google-consentimiento');
  }
  if (prov.github) {
    await page.goto(BASE + '/auth/github'); await page.waitForTimeout(1500); await shot(page, 'oauth-github-autorizacion');
  }

  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
