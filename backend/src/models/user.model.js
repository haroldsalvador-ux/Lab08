// Acceso a la tabla de usuarios.
const db = require('../config/db');

const PUBLIC_FIELDS = 'id, email, full_name, store, role, provider, created_at';

const User = {
  findByEmail(email) {
    return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  },

  findById(id) {
    return db.prepare(`SELECT ${PUBLIC_FIELDS} FROM users WHERE id = ?`).get(id);
  },

  create({ email, passwordHash = null, fullName, store, provider = 'local', providerId = null }) {
    const result = db
      .prepare('INSERT INTO users (email, password_hash, full_name, store, provider, provider_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(email, passwordHash, fullName, store, provider, providerId);
    return User.findById(result.lastInsertRowid);
  },

  // Login social: si el email ya existe se reutiliza la cuenta; si no, se crea.
  findOrCreateOAuth({ provider, providerId, email, fullName }) {
    const existing = User.findByEmail(email);
    if (existing) return User.findById(existing.id);
    return User.create({ email, fullName, store: 'Central', provider, providerId });
  },
};

module.exports = User;
