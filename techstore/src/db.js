// Capa de datos: SQLite nativo de Node (node:sqlite), sin dependencias externas.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const bcrypt = require('bcryptjs');

const db = new DatabaseSync(process.env.DB_FILE || path.join(__dirname, '..', 'techstore.db'));

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  email           TEXT UNIQUE NOT NULL,
  password_hash   TEXT,                       -- NULL para cuentas creadas solo con Google/GitHub
  full_name       TEXT NOT NULL,
  store           TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'EMPLEADO',
  provider        TEXT NOT NULL DEFAULT 'local',
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until    INTEGER,                    -- epoch ms; NULL = no bloqueado
  mfa_secret      TEXT,
  mfa_enabled     INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS mfa_sessions (
  id         TEXT PRIMARY KEY,               -- jti del token temporal MFA
  user_id    INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  used       INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  cognito_session TEXT,                      -- sesión del reto MFA de Amazon Cognito
  challenge  TEXT                            -- MFA_SETUP | SOFTWARE_TOKEN_MFA
);
CREATE TABLE IF NOT EXISTS products (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  sku   TEXT UNIQUE NOT NULL,
  name  TEXT NOT NULL,
  price REAL NOT NULL,
  stock INTEGER NOT NULL,
  store TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      TEXT NOT NULL DEFAULT (datetime('now')),
  user_id INTEGER,
  email   TEXT,
  action  TEXT NOT NULL,
  detail  TEXT
);
`);

function audit(user, action, detail = '') {
  db.prepare('INSERT INTO audit_log (user_id, email, action, detail) VALUES (?, ?, ?, ?)')
    .run(user?.id ?? null, user?.email ?? null, action, detail);
}

// Datos iniciales: un administrador y productos de ejemplo en dos tiendas.
function seed() {
  const admin = db.prepare('SELECT id FROM users WHERE email = ?').get(process.env.ADMIN_EMAIL);
  if (!admin && process.env.ADMIN_EMAIL) {
    // Con Amazon Cognito la contraseña vive en el User Pool: la fila local es solo una réplica.
    const cognito = process.env.AUTH_PROVIDER === 'cognito';
    db.prepare(`INSERT INTO users (email, password_hash, full_name, store, role, provider)
                VALUES (?, ?, 'Administrador TechStore', 'Central', 'ADMIN', ?)`)
      .run(process.env.ADMIN_EMAIL, cognito ? null : bcrypt.hashSync(process.env.ADMIN_PASSWORD, 12), cognito ? 'cognito' : 'local');
  }
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM products').get();
  if (n === 0) {
    const ins = db.prepare('INSERT INTO products (sku, name, price, stock, store) VALUES (?, ?, ?, ?, ?)');
    [
      ['LAP-001', 'Laptop Lenovo IdeaPad 5', 3299.9, 12, 'Lima Centro'],
      ['MON-002', 'Monitor LG 27" 4K', 1499.0, 8, 'Lima Centro'],
      ['MOU-003', 'Mouse Logitech MX Master 3S', 389.0, 40, 'Lima Centro'],
      ['SMA-004', 'Smartphone Samsung A55', 1599.0, 20, 'Arequipa'],
      ['AUD-005', 'Audífonos Sony WH-1000XM5', 1299.0, 6, 'Arequipa'],
      ['TEC-006', 'Teclado mecánico Redragon', 249.0, 25, 'Arequipa'],
    ].forEach((p) => ins.run(...p));
  }
}

module.exports = { db, audit, seed };
