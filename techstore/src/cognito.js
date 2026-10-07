// Integración con Amazon Cognito User Pools (AWS SDK v3).
// Cognito aplica la política de contraseñas, almacena las credenciales, gestiona el MFA TOTP
// y emite los JWT (firmados RS256 por AWS). Los grupos de Cognito representan los roles.
const {
  CognitoIdentityProviderClient, SignUpCommand, AdminConfirmSignUpCommand, AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand, InitiateAuthCommand, RespondToAuthChallengeCommand,
  AssociateSoftwareTokenCommand, VerifySoftwareTokenCommand, AdminListGroupsForUserCommand,
} = require('@aws-sdk/client-cognito-identity-provider');
const { CognitoJwtVerifier } = require('aws-jwt-verify');

const enabled = process.env.AUTH_PROVIDER === 'cognito';
const REGION = process.env.AWS_REGION;
const POOL = process.env.COGNITO_USER_POOL_ID;
const CLIENT = process.env.COGNITO_CLIENT_ID;
const DOMAIN = process.env.COGNITO_DOMAIN; // ej. techstore-xxxx.auth.us-east-1.amazoncognito.com

const client = enabled ? new CognitoIdentityProviderClient({ region: REGION }) : null;
const verifier = enabled ? CognitoJwtVerifier.create({ userPoolId: POOL, clientId: CLIENT, tokenUse: 'id' }) : null;
const ROLE_GROUPS = ['ADMIN', 'GERENTE', 'EMPLEADO', 'AUDITOR'];

async function signUp({ email, password, fullName, store }) {
  await client.send(new SignUpCommand({
    ClientId: CLIENT, Username: email, Password: password,
    UserAttributes: [{ Name: 'email', Value: email }, { Name: 'name', Value: fullName }, { Name: 'custom:store', Value: store }],
  }));
  // Confirmación administrativa (el laboratorio no exige verificar el email) + rol de menor privilegio.
  await client.send(new AdminConfirmSignUpCommand({ UserPoolId: POOL, Username: email }));
  await client.send(new AdminAddUserToGroupCommand({ UserPoolId: POOL, Username: email, GroupName: 'EMPLEADO' }));
}

// Paso 1: usuario + contraseña. Cognito responde con un reto MFA (MFA_SETUP o SOFTWARE_TOKEN_MFA).
async function initiate(email, password) {
  return client.send(new InitiateAuthCommand({
    ClientId: CLIENT, AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: email, PASSWORD: password },
  }));
}

// Enrolamiento TOTP: Cognito genera el secreto que se muestra como QR.
async function associateTotp(session) {
  const r = await client.send(new AssociateSoftwareTokenCommand({ Session: session }));
  return { secret: r.SecretCode, session: r.Session };
}

async function verifySetup(session, email, code) {
  const v = await client.send(new VerifySoftwareTokenCommand({ Session: session, UserCode: code, FriendlyDeviceName: 'Google Authenticator' }));
  return client.send(new RespondToAuthChallengeCommand({
    ClientId: CLIENT, ChallengeName: 'MFA_SETUP', Session: v.Session, ChallengeResponses: { USERNAME: email },
  }));
}

async function answerTotp(session, email, code) {
  return client.send(new RespondToAuthChallengeCommand({
    ClientId: CLIENT, ChallengeName: 'SOFTWARE_TOKEN_MFA', Session: session,
    ChallengeResponses: { USERNAME: email, SOFTWARE_TOKEN_MFA_CODE: code },
  }));
}

async function setGroup(email, role) {
  const cur = await client.send(new AdminListGroupsForUserCommand({ UserPoolId: POOL, Username: email }));
  for (const g of cur.Groups || [])
    if (ROLE_GROUPS.includes(g.GroupName) && g.GroupName !== role)
      await client.send(new AdminRemoveUserFromGroupCommand({ UserPoolId: POOL, Username: email, GroupName: g.GroupName }));
  await client.send(new AdminAddUserToGroupCommand({ UserPoolId: POOL, Username: email, GroupName: role }));
}

// Convierte el ID token de Cognito al formato de usuario que usa la API.
async function verifyIdToken(token) {
  const p = await verifier.verify(token);
  const groups = p['cognito:groups'] || [];
  return {
    sub: p.sub, email: p.email, name: p.name, store: p['custom:store'] || 'Central', scope: 'full',
    role: ROLE_GROUPS.find((r) => groups.includes(r)) || 'EMPLEADO', iss: p.iss,
  };
}

// Login con Google federado en Cognito (Hosted UI + OAuth 2.0 authorization code).
function googleAuthorizeUrl(redirectUri, state) {
  const q = new URLSearchParams({
    identity_provider: 'Google', response_type: 'code', client_id: CLIENT,
    redirect_uri: redirectUri, scope: 'openid email profile', state,
  });
  return `https://${DOMAIN}/oauth2/authorize?${q}`;
}

async function exchangeCode(code, redirectUri) {
  const r = await fetch(`https://${DOMAIN}/oauth2/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: CLIENT, code, redirect_uri: redirectUri }),
  });
  if (!r.ok) throw new Error('Cognito token endpoint: ' + r.status);
  return r.json();
}

module.exports = {
  enabled, signUp, initiate, associateTotp, verifySetup, answerTotp, setGroup, verifyIdToken,
  googleAuthorizeUrl, exchangeCode, googleEnabled: enabled && process.env.COGNITO_GOOGLE === '1',
};
