// API protegida de inventario con control de acceso por roles (RBAC).
//   ADMIN    -> todo, incluida la gestión de usuarios y roles
//   GERENTE  -> CRUD de productos solo de SU tienda, reportes de su ubicación
//   EMPLEADO -> consulta productos y actualiza stock; NO puede modificar precios
//   AUDITOR  -> solo lectura de todo + reportes
const express = require('express');
const { db, audit } = require('../db');
const { requireAuth, requireRole, ROLES } = require('../security');
const cognito = require('../cognito');

const router = express.Router();
router.use(requireAuth);

const ownStore = (user, store) => user.role === 'ADMIN' || user.store === store;

router.get('/me', (req, res) => res.json(req.user));

router.get('/products', (req, res) => {
  const all = ['ADMIN', 'AUDITOR'].includes(req.user.role);
  const rows = all
    ? db.prepare('SELECT * FROM products ORDER BY store, sku').all()
    : db.prepare('SELECT * FROM products WHERE store = ? ORDER BY sku').all(req.user.store);
  res.json(rows);
});

router.post('/products', requireRole('ADMIN', 'GERENTE'), (req, res) => {
  const { sku, name, price, stock } = req.body || {};
  const store = req.user.role === 'ADMIN' ? req.body.store : req.user.store;
  if (!sku || !name || !(price > 0) || !(stock >= 0) || !store) return res.status(400).json({ error: 'Datos inválidos' });
  try {
    db.prepare('INSERT INTO products (sku, name, price, stock, store) VALUES (?, ?, ?, ?, ?)').run(sku, name, price, stock, store);
  } catch {
    return res.status(409).json({ error: 'SKU duplicado' });
  }
  audit({ id: req.user.sub, email: req.user.email }, 'PRODUCT_CREATE', sku);
  res.status(201).json({ message: 'Producto creado' });
});

function loadProduct(req, res) {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!p) res.status(404).json({ error: 'Producto no existe' });
  return p;
}

// Cambiar precio / nombre: el EMPLEADO no puede modificar precios.
router.put('/products/:id', requireRole('ADMIN', 'GERENTE'), (req, res) => {
  const p = loadProduct(req, res); if (!p) return;
  if (!ownStore(req.user, p.store)) return res.status(403).json({ error: 'No puede modificar productos de otra tienda' });
  const price = Number(req.body.price ?? p.price);
  if (!(price > 0)) return res.status(400).json({ error: 'Precio inválido' });
  db.prepare('UPDATE products SET name = ?, price = ? WHERE id = ?').run(req.body.name ?? p.name, price, p.id);
  audit({ id: req.user.sub, email: req.user.email }, 'PRODUCT_UPDATE', `${p.sku} precio ${p.price} -> ${price}`);
  res.json({ message: 'Producto actualizado' });
});

// Actualizar stock en tiempo real.
router.patch('/products/:id/stock', requireRole('ADMIN', 'GERENTE', 'EMPLEADO'), (req, res) => {
  const p = loadProduct(req, res); if (!p) return;
  if (!ownStore(req.user, p.store)) return res.status(403).json({ error: 'No puede modificar stock de otra tienda' });
  const stock = Number(req.body.stock);
  if (!Number.isInteger(stock) || stock < 0) return res.status(400).json({ error: 'Stock inválido' });
  db.prepare('UPDATE products SET stock = ? WHERE id = ?').run(stock, p.id);
  audit({ id: req.user.sub, email: req.user.email }, 'STOCK_UPDATE', `${p.sku} ${p.stock} -> ${stock}`);
  res.json({ message: 'Stock actualizado' });
});

router.delete('/products/:id', requireRole('ADMIN', 'GERENTE'), (req, res) => {
  const p = loadProduct(req, res); if (!p) return;
  if (!ownStore(req.user, p.store)) return res.status(403).json({ error: 'No puede eliminar productos de otra tienda' });
  db.prepare('DELETE FROM products WHERE id = ?').run(p.id);
  audit({ id: req.user.sub, email: req.user.email }, 'PRODUCT_DELETE', p.sku);
  res.json({ message: 'Producto eliminado' });
});

router.get('/reports', requireRole('ADMIN', 'AUDITOR', 'GERENTE'), (req, res) => {
  const where = req.user.role === 'GERENTE' ? 'WHERE store = ?' : '';
  const args = req.user.role === 'GERENTE' ? [req.user.store] : [];
  res.json(db.prepare(`SELECT store, COUNT(*) AS productos, SUM(stock) AS unidades,
                       ROUND(SUM(stock * price), 2) AS valor_inventario
                       FROM products ${where} GROUP BY store`).all(...args));
});

// ---------- Administración (solo ADMIN) ----------
router.get('/admin/users', requireRole('ADMIN', 'AUDITOR'), (_req, res) => {
  res.json(db.prepare(`SELECT id, email, full_name, store, role, provider, failed_attempts,
                       locked_until, mfa_enabled FROM users ORDER BY id`).all());
});

router.patch('/admin/users/:id', requireRole('ADMIN'), async (req, res) => {
  const { role, store, unlock } = req.body || {};
  if (role && !ROLES.includes(role)) return res.status(400).json({ error: 'Rol inválido' });
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Usuario no existe' });
  // En Cognito el rol es un grupo del User Pool: se refleja en el claim cognito:groups del siguiente token.
  if (role && u.provider === 'cognito') await cognito.setGroup(u.email, role);
  db.prepare('UPDATE users SET role = ?, store = ? WHERE id = ?').run(role || u.role, store || u.store, u.id);
  if (unlock) db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?').run(u.id);
  audit({ id: req.user.sub, email: req.user.email }, 'USER_UPDATE', `${u.email} rol=${role || u.role}${unlock ? ' desbloqueado' : ''}`);
  res.json({ message: 'Usuario actualizado' });
});

router.get('/audit', requireRole('ADMIN', 'AUDITOR'), (_req, res) => {
  res.json(db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 50').all());
});

module.exports = router;
