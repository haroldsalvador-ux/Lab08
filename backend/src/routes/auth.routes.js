// Rutas de autenticación.
const { Router } = require('express');
const { register, login, me } = require('../controllers/auth.controller');
const { oauthSuccess, oauthFailure } = require('../controllers/oauth.controller');
const { passport, enabled } = require('../config/passport');
const { requireAuth } = require('../middlewares/auth.middleware');

const router = Router();

router.post('/register', register);
router.post('/login', login);
router.get('/me', requireAuth, me);

// ---------- Login social ----------
// Qué proveedores están configurados
router.get('/providers', (_req, res) => res.json(enabled));

const SCOPES = { github: ['user:email'], google: ['profile', 'email'] };

for (const provider of ['github', 'google']) {
  // 1) Redirige a la pantalla de autorización de GitHub / Google
  router.get(`/${provider}`, (req, res, next) => {
    if (!enabled[provider]) return res.status(503).json({ error: `Login con ${provider} no configurado (revisar .env)` });
    passport.authenticate(provider, { session: false, scope: SCOPES[provider] })(req, res, next);
  });

  // 2) El proveedor vuelve aquí con un código; Passport lo canjea por el perfil del usuario
  router.get(`/${provider}/callback`,
    (req, res, next) => passport.authenticate(provider, { session: false, failureRedirect: '/api/auth/oauth/failure' })(req, res, next),
    oauthSuccess);
}

router.get('/oauth/failure', oauthFailure);

module.exports = router;
