// Reglas de validación de datos de entrada.

const STORES = ['Central', 'Lima Centro', 'Arequipa'];

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Mínimo 8 caracteres, al menos una mayúscula, un número y un carácter especial.
const PASSWORD_REGEX = /^(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/;

function validateRegister({ email, password, fullName, store }) {
  const errors = [];
  if (!email || !EMAIL_REGEX.test(email)) errors.push('Email inválido');
  if (!password || !PASSWORD_REGEX.test(password)) {
    errors.push('La contraseña debe tener mínimo 8 caracteres, una mayúscula, un número y un carácter especial');
  }
  if (!fullName || fullName.trim().length < 3) errors.push('El nombre completo es obligatorio');
  if (!STORES.includes(store)) errors.push(`La tienda debe ser una de: ${STORES.join(', ')}`);
  return errors;
}

module.exports = { STORES, validateRegister };
