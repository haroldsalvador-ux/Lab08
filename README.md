# TechStore · Laboratorio Calificado Semana 08

**Curso:** Desarrollo de Soluciones en la Nube · Tecsup

Sistema de gestión de inventario con controles de seguridad, desplegado en **Amazon Web Services**.

## Qué implementa

| Requisito | Implementación |
|---|---|
| Registro de usuarios | Email único, contraseña de 8+ caracteres con mayúscula, número y símbolo, nombre completo y tienda asignada |
| Login básico | Validación de credenciales, token **JWT** y **bloqueo tras 5 intentos fallidos** (15 min) |
| Login social | Google (federado en Amazon Cognito) y GitHub (OAuth 2.0 con Passport) |
| MFA (Opción A) | **TOTP** con Google Authenticator: 6 dígitos cada 30 s y máximo 3 intentos |
| Perfiles | RBAC: Administrador, Gerente de Tienda, Empleado de Ventas y Auditor |
| Auditoría | Bitácora propia y AWS CloudTrail |

## Arquitectura en AWS (región us-east-2)

```
Usuario ──HTTPS──► Amazon CloudFront ──► Amazon EC2 (Node.js, Amazon Linux 2023)
                                              ├── Amazon Cognito (usuarios, MFA, grupos, JWT)
                                              ├── SSM Parameter Store + KMS (secretos)
                                              └── Amazon S3 (artefacto de despliegue)
IAM (rol con mínimo privilegio) · Security Group (solo CloudFront) · EBS cifrado · CloudTrail
```

## Estructura

```
techstore/             código de la aplicación
├── server.js
├── src/               db.js, security.js, cognito.js, routes/ (auth, oauth, api)
├── public/            login, registro, MFA, panel por roles
├── infra/             scripts de AWS CLI (Cognito, EC2/CloudFront, Google, eliminación)
├── capturas.js        evidencia en modo local
├── capturas-aws.js    evidencia y video sobre AWS
└── aws-evidencia.js   evidencia de la infraestructura con AWS CLI
capturas/              capturas en modo local
capturas-aws/          capturas de la app en AWS y de los servicios (aws-cli/)
video/                 video de demostración
GLAB-S08-TechStore-Desarrollado.docx   informe del laboratorio
```

## Ejecutar en local

```bash
cd techstore
cp .env.example .env      # definir JWT_SECRET y ADMIN_PASSWORD
npm install
npm start                 # http://localhost:3000
```

## Desplegar en AWS

Requiere la AWS CLI con una sesión iniciada (`aws login`).

```bash
cd techstore
bash infra/01-cognito.sh        # User Pool, MFA TOTP, grupos, App Client y admin
bash infra/02-ec2.sh            # S3, IAM, Parameter Store, Security Group, EC2 y CloudFront
bash infra/03-google.sh         # opcional: Google como proveedor en Cognito
bash infra/99-eliminar-todo.sh  # elimina todos los recursos
```
