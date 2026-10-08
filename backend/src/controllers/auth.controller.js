// Lógica de autenticación con email y contraseña.
const bcrypt = require('bcryptjs');
const User = require('../models/user.model');
const { validateRegister } = require('../utils/validators');
const { signToken } = require('../utils/jwt');

// POST /api/auth/register
async function register(req, res) {
  const { email, password, fullName, store } = req.body || {};

  const errors = validateRegister({ email, password, fullName, store });
  if (errors.length) return res.status(400).json({ errors });

  const normalizedEmail = email.trim().toLowerCase();
  if (User.findByEmail(normalizedEmail)) {
    return res.status(409).json({ errors: ['El email ya está registrado'] });
  }

  // La contraseña nunca se guarda en texto plano: se guarda su hash bcrypt.
  const passwordHash = await bcrypt.hash(password, 12);
  const user = User.create({ email: normalizedEmail, passwordHash, fullName: fullName.trim(), store });

  return res.status(201).json({ message: 'Usuario registrado correctamente', user });
}

// POST /api/auth/login
async function login(req, res) {
  const { email, password } = req.body || {};
  const user = User.findByEmail(String(email || '').trim().toLowerCase());

  // Mensaje genérico: no revela si el email existe.
  if (!user || !user.password_hash || !(await bcrypt.compare(String(password || ''), user.password_hash))) {
    return res.status(401).json({ error: 'Email o contraseña incorrectos' });
  }

  const publicUser = User.findById(user.id);
  return res.json({ message: 'Login correcto', token: signToken(publicUser), user: publicUser });
}

// GET /api/auth/me  (requiere token)
function me(req, res) {
  const user = User.findById(req.user.sub);
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  return res.json({ user });
}

module.exports = { register, login, me };
