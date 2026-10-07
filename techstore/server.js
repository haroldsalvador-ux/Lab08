require('dotenv').config();
const express = require('express');
const path = require('path');
const passport = require('passport');
const { seed } = require('./src/db');

if (!process.env.JWT_SECRET) throw new Error('Falta JWT_SECRET en .env');
seed();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));
app.use((_req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  });
  next();
});
app.use(passport.initialize());

app.use('/api/auth', require('./src/routes/auth'));
app.use('/auth', require('./src/routes/oauth'));
app.use('/api', require('./src/routes/api'));
app.use(express.static(path.join(__dirname, 'public')));

const port = process.env.PORT || 3000;
const server = app.listen(port, () => console.log(`TechStore escuchando en http://localhost:${port}`));
// Detrás de CloudFront: mantener las conexiones abiertas más tiempo que el proxy
// para que no reutilice una conexión que Node ya cerró (peticiones colgadas / 502).
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
