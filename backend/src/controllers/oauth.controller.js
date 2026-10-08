// Respuesta final del login social (Google / GitHub).
const { signToken } = require('../utils/jwt');

// Emite el JWT y lleva al usuario a la página de bienvenida.
// El token va en el fragmento (#), que el navegador no envía al servidor ni queda en los logs.
function oauthSuccess(req, res) {
  const token = signToken(req.user);
  res.redirect(`/bienvenido.html#token=${encodeURIComponent(token)}`);
}

function oauthFailure(_req, res) {
  res.redirect('/?error=oauth');
}

module.exports = { oauthSuccess, oauthFailure };
