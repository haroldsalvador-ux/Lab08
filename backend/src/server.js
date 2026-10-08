// Punto de entrada: carga la configuración y levanta el servidor.
require('dotenv').config();
const app = require('./app');

const PORT = process.env.PORT || 4000;
const server = app.listen(PORT, () => console.log(`TechStore API escuchando en http://localhost:${PORT}`));

// Detrás de CloudFront: mantener las conexiones abiertas más tiempo que el proxy
// para que no reutilice una conexión que Node ya cerró.
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
