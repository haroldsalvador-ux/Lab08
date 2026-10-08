# TechStore · Laboratorio Calificado Semana 08

**Curso:** Desarrollo de Soluciones en la Nube · Tecsup

Backend de un sistema de inventario con autenticación segura, publicado en **Amazon Web Services**.

**Aplicación:** https://d3t7wai248dbtq.cloudfront.net

## Funcionalidades

- **Registro** con email único, contraseña segura (8+ caracteres, mayúscula, número y símbolo), nombre y tienda.
- **Login con email y contraseña**: contraseñas cifradas con bcrypt y token **JWT**.
- **Login con Google y GitHub** (OAuth 2.0 con Passport).
- Página protegida que valida el JWT (`/api/auth/me`).

## Arquitectura en AWS (us-east-2)

```
Usuario ──HTTPS──► CloudFront ──► EC2 (Node.js, Amazon Linux 2023)
                                   ├── SSM Parameter Store (secretos cifrados con KMS)
                                   └── S3 (código de despliegue)
IAM con mínimo privilegio · Security Group solo para CloudFront · disco cifrado · sin SSH
```

## Estructura

```
backend/
├── src/
│   ├── config/        base de datos y estrategias OAuth (Passport)
│   ├── models/        usuarios
│   ├── controllers/   registro, login, OAuth
│   ├── routes/        rutas de la API
│   ├── middlewares/   verificación de JWT
│   └── utils/         validaciones y JWT
├── public/            login, registro y bienvenida
├── scripts/           listar usuarios (se ejecuta en EC2 con Systems Manager)
└── infra/             despliegue en AWS con AWS CLI
video/                 demostración
GLAB-S08-TechStore.docx  informe
```

## Ejecutar en local

```bash
cd backend
npm install
npm run dev        # http://localhost:4000
```

El archivo `backend/.env` (no incluido) necesita: `PORT`, `JWT_SECRET`, `BASE_URL`,
`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.

## Publicar en AWS

```bash
cd backend
bash infra/deploy-aws.sh
```
