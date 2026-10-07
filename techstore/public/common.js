// Helpers compartidos del frontend.
const $ = (s) => document.querySelector(s);

function showMsg(el, text, ok = false) {
  el.className = 'msg ' + (ok ? 'ok' : 'err');
  el.textContent = text;
}

async function api(path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// Mismas reglas que el backend (el backend siempre vuelve a validar).
const PASSWORD_CHECKS = [
  ['len', 'Mínimo 8 caracteres', (p) => p.length >= 8],
  ['up', 'Al menos una mayúscula', (p) => /[A-Z]/.test(p)],
  ['num', 'Al menos un número', (p) => /\d/.test(p)],
  ['spc', 'Al menos un carácter especial', (p) => /[^A-Za-z0-9]/.test(p)],
];
