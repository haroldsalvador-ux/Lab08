// Parte 1 (registro, login, bloqueo) y Parte 2 (MFA TOTP).
// Con AUTH_PROVIDER=cognito las credenciales, la política de contraseñas, el MFA y los JWT los gestiona
// Amazon Cognito; la app conserva el bloqueo de 5 intentos, el límite de 3 intentos MFA y la bitácora.
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const { db, audit } = require('../db');
const S = require('../security');
const cognito = require('../cognito');

const router = express.Router();
authenticator.options = { step: 30, digits: 6, window: 1 }; // código de 6 dígitos cada 30 s

const STORES = ['Central', 'Lima Centro', 'Arequipa'];
const findUser = (email) => db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').toLowerCase());

// ---------- Registro ----------
router.post('/register', async (req, res) => {
  const { email, password, fullName, store } = req.body || {};
  const errors = [];
  if (!email || !S.EMAIL_RULE.test(email)) errors.push('Email inválido');
  if (!password || !S.PASSWORD_RULE.test(password))
    errors.push('La contraseña debe tener mínimo 8 caracteres, una mayúscula, un número y un carácter especial');
  if (!fullName || fullName.trim().length < 3) errors.push('Nombre completo requerido');
  if (!STORES.includes(store)) errors.push('Tienda asignada inválida');
  if (errors.length) return res.status(400).json({ errors });

  const mail = email.toLowerCase();
  if (findUser(mail)) return res.status(409).json({ errors: ['El email ya está registrado'] });

  let hash = null;
  if (cognito.enabled) {
    try {
      await cognito.signUp({ email: mail, password, fullName: fullName.trim(), store });
    } catch (e) {
      if (e.name === 'UsernameExistsException') return res.status(409).json({ errors: ['El email ya está registrado'] });
      if (e.name === 'InvalidPasswordException') return res.status(400).json({ errors: ['Cognito: ' + e.message] });
      throw e;
    }
  } else {
    hash = bcrypt.hashSync(password, 12); // bcrypt con salt, costo 12
  }
  const info = db.prepare('INSERT INTO users (email, password_hash, full_name, store, provider) VALUES (?, ?, ?, ?, ?)')
    .run(mail, hash, fullName.trim(), store, cognito.enabled ? 'cognito' : 'local');
  audit({ id: info.lastInsertRowid, email: mail }, 'REGISTER', `tienda=${store}${cognito.enabled ? ' (Amazon Cognito)' : ''}`);
  res.status(201).json({
    message: `Usuario registrado${cognito.enabled ? ' en Amazon Cognito' : ''}. Rol inicial: EMPLEADO (el administrador puede cambiarlo).`,
  });
});

router.get('/stores', (_req, res) => res.json(STORES));
router.get('/provider', (_req, res) => res.json({ provider: cognito.enabled ? 'cognito' : 'local' }));

// ---------- Login básico ----------
function registerFailure(user, res) {
  const attempts = user.failed_attempts + 1;
  if (attempts >= S.MAX_LOGIN_ATTEMPTS) {
    db.prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?')
      .run(attempts, Date.now() + S.LOCK_MINUTES * 60000, user.id);
    audit(user, 'ACCOUNT_LOCKED', `${attempts} intentos fallidos`);
    return res.status(423).json({ error: `Cuenta bloqueada por ${S.MAX_LOGIN_ATTEMPTS} intentos fallidos durante ${S.LOCK_MINUTES} minutos.` });
  }
  db.prepare('UPDATE users SET failed_attempts = ? WHERE id = ?').run(attempts, user.id);
  audit(user, 'LOGIN_FAILED', `intento ${attempts}/${S.MAX_LOGIN_ATTEMPTS}`);
  return res.status(401).json({ error: 'Credenciales inválidas', remaining: S.MAX_LOGIN_ATTEMPTS - attempts });
}

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  const mail = String(email || '').toLowerCase();
  let user = findUser(mail);

  // Con Cognito, un usuario creado directamente en el User Pool aún no tiene fila local:
  // se crea una réplica para poder contar intentos y registrar la auditoría.
  if (!user && cognito.enabled && S.EMAIL_RULE.test(mail)) {
    db.prepare(`INSERT INTO users (email, full_name, store, provider) VALUES (?, ?, 'Central', 'cognito')`).run(mail, mail);
    user = findUser(mail);
  }
  if (!user) return res.status(401).json({ error: 'Credenciales inválidas' }); // mensaje genérico

  if (user.locked_until && user.locked_until > Date.now()) {
    const min = Math.ceil((user.locked_until - Date.now()) / 60000);
    audit(user, 'LOGIN_BLOCKED', 'intento sobre cuenta bloqueada');
    return res.status(423).json({ error: `Cuenta bloqueada por ${S.MAX_LOGIN_ATTEMPTS} intentos fallidos. Intente en ${min} min o contacte al administrador.` });
  }

  let cg = {};
  if (cognito.enabled) {
    try {
      const r = await cognito.initiate(mail, String(password || ''));
      if (!['MFA_SETUP', 'SOFTWARE_TOKEN_MFA'].includes(r.ChallengeName))
        return res.status(500).json({ error: 'El User Pool debe exigir MFA TOTP' });
      cg = { session: r.Session, challenge: r.ChallengeName };
    } catch (e) {
      if (['NotAuthorizedException', 'UserNotFoundException'].includes(e.name)) return registerFailure(user, res);
      throw e;
    }
  } else if (!user.password_hash || !bcrypt.compareSync(String(password || ''), user.password_hash)) {
    return registerFailure(user, res);
  }

  db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?').run(user.id);
  audit(user, 'LOGIN_PASSWORD_OK', cognito.enabled ? `Cognito reto ${cg.challenge}` : 'esperando MFA');
  res.json({
    mfaRequired: true,
    mfaSetup: cognito.enabled ? cg.challenge === 'MFA_SETUP' : !user.mfa_enabled, // primer ingreso: enrolar TOTP
    mfaToken: S.issueMfaToken(user, cg),
  });
});

// ---------- MFA (TOTP) ----------
function readMfaToken(req, res) {
  try {
    const payload = jwt.verify(req.body?.mfaToken || '', S.JWT_SECRET, { algorithms: ['HS256'] });
    if (payload.scope !== 'mfa_pending') throw new Error();
    const session = db.prepare('SELECT * FROM mfa_sessions WHERE id = ?').get(payload.jti);
    if (!session || session.used || session.attempts >= S.MAX_MFA_ATTEMPTS) {
      res.status(401).json({ error: 'Sesión MFA inválida. Vuelva a iniciar sesión.' });
      return null;
    }
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub);
    return { session, user };
  } catch {
    res.status(401).json({ error: 'Token MFA inválido o expirado (5 min). Vuelva a iniciar sesión.' });
    return null;
  }
}

// Genera el secreto TOTP y el QR para escanear con Google Authenticator.
router.post('/mfa/setup', async (req, res) => {
  const ctx = readMfaToken(req, res);
  if (!ctx) return;
  const { session, user } = ctx;
  let secret;
  if (session.cognito_session) {
    if (session.challenge !== 'MFA_SETUP') return res.status(400).json({ error: 'MFA ya configurado' });
    const r = await cognito.associateTotp(session.cognito_session); // el secreto lo genera Amazon Cognito
    db.prepare('UPDATE mfa_sessions SET cognito_session = ? WHERE id = ?').run(r.session, session.id);
    secret = r.secret;
  } else {
    if (user.mfa_enabled) return res.status(400).json({ error: 'MFA ya configurado' });
    secret = user.mfa_secret || authenticator.generateSecret();
    db.prepare('UPDATE users SET mfa_secret = ? WHERE id = ?').run(secret, user.id);
  }
  const otpauth = authenticator.keyuri(user.email, 'TechStore', secret);
  res.json({ secret, qr: await QRCode.toDataURL(otpauth), provider: session.cognito_session ? 'cognito' : 'local' });
});

router.post('/mfa/verify', async (req, res) => {
  const ctx = readMfaToken(req, res);
  if (!ctx) return;
  const { session, user } = ctx;
  const code = String(req.body?.code || '');

  const fail = () => {
    const attempts = session.attempts + 1;
    db.prepare('UPDATE mfa_sessions SET attempts = ? WHERE id = ?').run(attempts, session.id);
    audit(user, 'MFA_FAILED', `intento ${attempts}/${S.MAX_MFA_ATTEMPTS}`);
    if (attempts >= S.MAX_MFA_ATTEMPTS)
      return res.status(401).json({ error: 'Se agotaron los 3 intentos de MFA. Vuelva a iniciar sesión.', remaining: 0 });
    return res.status(401).json({ error: 'Código MFA incorrecto', remaining: S.MAX_MFA_ATTEMPTS - attempts });
  };
  if (!/^\d{6}$/.test(code)) return fail();

  if (session.cognito_session) {
    let r;
    try {
      r = session.challenge === 'MFA_SETUP'
        ? await cognito.verifySetup(session.cognito_session, user.email, code)
        : await cognito.answerTotp(session.cognito_session, user.email, code);
    } catch (e) {
      if (['CodeMismatchException', 'EnableSoftwareTokenMFAException'].includes(e.name)) return fail();
      if (e.name === 'NotAuthorizedException')
        return res.status(401).json({ error: 'La sesión de Cognito expiró. Vuelva a iniciar sesión.' });
      throw e;
    }
    if (r.Session) db.prepare('UPDATE mfa_sessions SET cognito_session = ? WHERE id = ?').run(r.Session, session.id);
    const idToken = r.AuthenticationResult?.IdToken;
    if (!idToken) return res.status(500).json({ error: 'Cognito no devolvió tokens' });
    const claims = await cognito.verifyIdToken(idToken);
    db.prepare('UPDATE mfa_sessions SET used = 1 WHERE id = ?').run(session.id);
    db.prepare('UPDATE users SET mfa_enabled = 1, role = ?, store = ?, full_name = ? WHERE id = ?')
      .run(claims.role, claims.store, claims.name || user.full_name, user.id);
    audit(user, 'LOGIN_SUCCESS', 'MFA verificado por Amazon Cognito, ID token emitido');
    return res.json({
      token: idToken,
      user: { email: user.email, fullName: claims.name || user.full_name, role: claims.role, store: claims.store, provider: 'cognito' },
    });
  }

  if (!user.mfa_secret || !authenticator.check(code, user.mfa_secret)) return fail();
  db.prepare('UPDATE mfa_sessions SET used = 1 WHERE id = ?').run(session.id);
  if (!user.mfa_enabled) db.prepare('UPDATE users SET mfa_enabled = 1 WHERE id = ?').run(user.id);
  audit(user, 'LOGIN_SUCCESS', 'MFA verificado, JWT completo emitido');
  res.json({
    token: S.issueAccessToken(user),
    user: { email: user.email, fullName: user.full_name, role: user.role, store: user.store },
  });
});

module.exports = router;
