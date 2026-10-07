// Utilidades de seguridad: JWT, validación de contraseñas y control de acceso por roles (RBAC).
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { db } = require('./db');
const cognito = require('./cognito');

const JWT_SECRET = process.env.JWT_SECRET;
const MAX_LOGIN_ATTEMPTS = 5;            // bloqueo después de 5 intentos fallidos
const LOCK_MINUTES = 15;
const MAX_MFA_ATTEMPTS = 3;              // máximo 3 intentos de código MFA
const MFA_TOKEN_TTL_SEC = 5 * 60;

// Mínimo 8 caracteres, al menos una mayúscula, un número y un carácter especial.
const PASSWORD_RULE = /^(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/;
const EMAIL_RULE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ROLES = ['ADMIN', 'GERENTE', 'EMPLEADO', 'AUDITOR'];

// Token temporal: solo sirve para completar el MFA, no da acceso a la API.
function issueMfaToken(user, cg = {}) {
  const jti = crypto.randomUUID();
  db.prepare('INSERT INTO mfa_sessions (id, user_id, expires_at, cognito_session, challenge) VALUES (?, ?, ?, ?, ?)')
    .run(jti, user.id, Date.now() + MFA_TOKEN_TTL_SEC * 1000, cg.session ?? null, cg.challenge ?? null);
  return jwt.sign({ sub: user.id, scope: 'mfa_pending' }, JWT_SECRET, { expiresIn: MFA_TOKEN_TTL_SEC, jwtid: jti });
}

// Token completo: se emite solo después de validar el segundo factor.
function issueAccessToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role, store: user.store, scope: 'full', amr: ['pwd', 'otp'] },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

// Acepta el JWT propio (HS256) o el ID token emitido por Amazon Cognito (RS256, validado con sus JWKS).
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Token requerido' });
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    try {
      if (cognito.enabled) payload = await cognito.verifyIdToken(token);
    } catch { /* inválido para ambos emisores */ }
  }
  if (!payload) return res.status(401).json({ error: 'Token inválido o expirado' });
  if (payload.scope !== 'full') return res.status(401).json({ error: 'MFA pendiente: token sin acceso completo' });
  req.user = payload;
  next();
}

function requireRole(...roles) {
  return (req, res, next) =>
    roles.includes(req.user.role)
      ? next()
      : res.status(403).json({ error: `Acceso denegado: se requiere rol ${roles.join(' o ')}` });
}

module.exports = {
  JWT_SECRET, MAX_LOGIN_ATTEMPTS, LOCK_MINUTES, MAX_MFA_ATTEMPTS,
  PASSWORD_RULE, EMAIL_RULE, ROLES,
  issueMfaToken, issueAccessToken, requireAuth, requireRole,
};
