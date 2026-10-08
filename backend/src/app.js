// Configuración de la aplicación Express.
const express = require('express');
const path = require('path');
const authRoutes = require('./routes/auth.routes');
const { passport } = require('./config/passport');

const app = express();
app.use(express.json());
app.use(passport.initialize());

app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'TechStore API' }));
app.use('/api/auth', authRoutes);

// Páginas web (login, registro, bienvenida)
app.use(express.static(path.join(__dirname, '..', 'public')));

module.exports = app;
