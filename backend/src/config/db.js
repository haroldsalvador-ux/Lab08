// Conexión a la base de datos (SQLite incluido en Node.js) y creación de tablas.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(path.join(__dirname, '..', '..', 'techstore.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT    NOT NULL UNIQUE,
    password_hash TEXT,                              -- NULL si entra solo con Google/GitHub
    full_name     TEXT    NOT NULL,
    store         TEXT    NOT NULL,
    role          TEXT    NOT NULL DEFAULT 'EMPLEADO',
    provider      TEXT    NOT NULL DEFAULT 'local',  -- local | google | github
    provider_id   TEXT,                              -- id del usuario en Google/GitHub
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);

module.exports = db;
