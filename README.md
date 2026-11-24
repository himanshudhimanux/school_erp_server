# School ERP — API server

Multi-tenant School ERP REST API: Node.js 20+, Express 5, MongoDB (Mongoose 9), JavaScript ES modules.

The full API reference is in [docs/API.md](docs/API.md).

## Quick start

```bash
npm install
cp .env.example .env        # then set JWT_ACCESS_SECRET (32+ characters) and MONGODB_URI
npm run seed -- --reset     # demo plans, super admin, 2 schools (password: Password@123)
npm run dev                 # http://localhost:5000/api/v1
npm test                    # uses the <db>_test database
```

## MongoDB transactions

Fee payments, refunds, payroll payments and result publishing need multi-document transactions, so MongoDB must run as a replica set. MongoDB Atlas works out of the box. A single-node replica set is enough for local development. On a standalone server, these operations return `503 TRANSACTIONS_UNAVAILABLE` instead of saving partial records.

## Optional integrations (see `.env.example`)

| Feature | Settings |
|---|---|
| Email | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` |
| SMS and WhatsApp (Twilio) | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_SMS_FROM`, `TWILIO_WHATSAPP_FROM`, `PUBLIC_API_URL` (delivery receipts) |
| Push (Firebase Cloud Messaging) | `FCM_SERVICE_ACCOUNT` |
| Online fee payments (Razorpay) | Each school sets its own keys in the app; `DATA_ENCRYPTION_KEY` encrypts them |

A channel that is not configured is never offered as available. Messages on it are recorded as failed, with the reason.

## Layout

```
src/
  config/        environment and database
  middleware/    authentication, tenant context, permissions, validation, errors
  modules/<x>/   models, validators, services and routes per module
  jobs/          scheduler (late fees, fee reminders, scheduled announcements, delivery retries)
  services/      mail, Twilio, FCM
tests/           node:test + supertest integration tests
scripts/seed.js  demo data
```
