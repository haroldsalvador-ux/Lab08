// Login con redes sociales (Google y GitHub) usando OAuth 2.0 vía Passport.
// Después del proveedor externo, el usuario igual pasa por el MFA TOTP.
const express = require('express');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const GitHubStrategy = require('passport-github2').Strategy;
const { db, audit } = require('../db');
const S = require('../security');
const cognito = require('../cognito');
const crypto = require('crypto');

const router = express.Router();
const BASE = process.env.BASE_URL || 'http://localhost:3000';

function findOrCreate(provider, profile, done) {
  const email = (profile.emails?.[0]?.value || `${profile.username || profile.id}@${provider}.oauth`).toLowerCase();
  let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) {
    db.prepare(`INSERT INTO users (email, full_name, store, provider) VALUES (?, ?, 'Central', ?)`)
      .run(email, profile.displayName || profile.username || email, provider);
    user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    audit(user, 'REGISTER_OAUTH', provider);
  }
  done(null, user);
}

const enabled = { google: false, github: false };

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: `${BASE}/auth/google/callback`,
  }, (_a, _r, profile, done) => findOrCreate('google', profile, done)));
  enabled.google = true;
}
if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
  passport.use(new GitHubStrategy({
    clientID: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
    callbackURL: `${BASE}/auth/github/callback`,
    scope: ['user:email'],
  }, (_a, _r, profile, done) => findOrCreate('github', profile, done)));
  enabled.github = true;
}

// Google federado en Amazon Cognito: Cognito habla con Google y devuelve su propio ID token.
if (cognito.googleEnabled) enabled.google = true;
const states = new Map(); // state anti-CSRF del flujo OAuth (vida 10 min)
const COGNITO_CALLBACK = `${BASE}/auth/cognito/callback`;

router.get('/google', (req, res, next) => {
  if (!cognito.googleEnabled) return next();
  const state = crypto.randomBytes(16).toString('hex');
  states.set(state, Date.now() + 600000);
  res.redirect(cognito.googleAuthorizeUrl(COGNITO_CALLBACK, state));
});

router.get('/cognito/callback', async (req, res) => {
  const { code, state } = req.query;
  const exp = states.get(state);
  states.delete(state);
  if (!code || !exp || exp < Date.now()) return res.redirect('/?error=oauth');
  try {
    const tokens = await cognito.exchangeCode(code, COGNITO_CALLBACK);
    const claims = await cognito.verifyIdToken(tokens.id_token);
    findOrCreate('google', { emails: [{ value: claims.email }], displayName: claims.name }, (_e, user) => {
      req.user = { ...user, provider: 'cognito-google' };
      finish(req, res);
    });
  } catch (e) {
    console.error(e);
    res.redirect('/?error=oauth');
  }
});

router.get('/providers', (_req, res) => res.json(enabled));

function finish(req, res) {
  const user = req.user;
  audit(user, 'LOGIN_OAUTH_OK', `${user.provider} - esperando MFA`);
  const q = new URLSearchParams({ t: S.issueMfaToken(user), setup: user.mfa_enabled ? '0' : '1' });
  res.redirect(`/mfa.html#${q}`); // en el fragmento (#) para que no viaje en logs del servidor
}

for (const name of ['google', 'github']) {
  router.get(`/${name}`, (req, res, next) => {
    if (!enabled[name]) return res.status(503).send(`Login con ${name} no configurado (ver .env)`);
    passport.authenticate(name, { session: false, scope: name === 'google' ? ['profile', 'email'] : ['user:email'] })(req, res, next);
  });
  router.get(`/${name}/callback`,
    (req, res, next) => passport.authenticate(name, { session: false, failureRedirect: '/?error=oauth' })(req, res, next),
    finish);
}

module.exports = router;
