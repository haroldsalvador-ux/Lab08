// Lista los usuarios registrados en la base de datos (se ejecuta en el servidor EC2 vía Systems Manager).
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(path.join(__dirname, '..', 'techstore.db'));
const users = db.prepare(`
  SELECT id, email, full_name AS nombre, provider AS ingreso, role AS rol, store AS tienda, created_at AS creado
  FROM users ORDER BY id`).all();

console.log(`Usuarios registrados en TechStore: ${users.length}\n`);
for (const u of users) {
  console.log(`#${u.id}  ${u.email}`);
  console.log(`    Nombre: ${u.nombre} | Ingreso: ${u.ingreso} | Rol: ${u.rol} | Tienda: ${u.tienda} | Creado: ${u.creado}\n`);
}
