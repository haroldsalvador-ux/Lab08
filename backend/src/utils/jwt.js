// Generación de tokens JWT.
const jwt = require('jsonwebtoken');

function signToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role, store: user.store },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
}

module.exports = { signToken };
