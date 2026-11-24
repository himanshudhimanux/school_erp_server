# Deploying School ERP on an Ubuntu VPS

This guide puts the API (this repository) and the web app ([school_erp_web](https://github.com/himanshudhimanux/school_erp_web)) on one Ubuntu 22.04 or 24.04 server. Nginx serves the web app and proxies `/api`, PM2 keeps the API running, and MongoDB Atlas (or a self-hosted replica set) holds the data. No Docker is needed.

```
Browser / Android app ──HTTPS──> Nginx :443 ─┬─ /            → /var/www/school-erp (web build)
                                              └─ /api/        → PM2 cluster → Node API :5000 ──> MongoDB (replica set)
```

**Server size:** start with 2 vCPU and 4 GB RAM for a few schools of about 2,000 students each. See "Capacity" at the end.

## 1. Server basics

```bash
# As root, once
adduser erp && usermod -aG sudo erp
apt update && apt -y upgrade
apt -y install nginx git curl rsync ufw
ufw allow OpenSSH && ufw allow 'Nginx Full' && ufw --force enable    # only 22, 80, 443 are open
timedatectl set-timezone Asia/Kolkata
```

Log in as `erp` from now on. Use SSH keys and disable password login in `/etc/ssh/sshd_config` (`PasswordAuthentication no`).

## 2. Node.js 22 and PM2

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt -y install nodejs
sudo npm install -g pm2
pm2 install pm2-logrotate                       # keeps logs from filling the disk
pm2 set pm2-logrotate:max_size 50M && pm2 set pm2-logrotate:retain 14
```

## 3. MongoDB

The API **requires a replica set**: fee payments, refunds, payroll and result publishing use transactions.

**Option A: MongoDB Atlas (recommended).**
1. Create a cluster. M10 or higher gives continuous backups.
2. Create a database user, and allow only your server's IP under Network Access.
3. Use a connection string that **includes the database name**:
   `mongodb+srv://USER:PASS@cluster0.xxxxx.mongodb.net/school_erp?retryWrites=true&w=majority`
   Without a name, everything goes into a database called `test`.

**Option B: self-hosted on the same server.**
1. Install MongoDB 7+ from mongodb.org.
2. In `/etc/mongod.conf` set `replication.replSetName: rs0`, keep `net.bindIp: 127.0.0.1`, and enable `security.authorization`.
3. Restart mongod, run `rs.initiate()` in mongosh, then create a user.
4. Use `mongodb://USER:PASS@127.0.0.1:27017/school_erp?replicaSet=rs0&authSource=admin`.

Install the database tools for backups: `sudo apt -y install mongodb-database-tools` (from the MongoDB apt repository).

## 4. Get the code

```bash
sudo mkdir -p /opt/school-erp /var/www/school-erp && sudo chown erp:erp /opt/school-erp /var/www/school-erp
cd /opt/school-erp
git clone https://github.com/himanshudhimanux/school_erp_server.git backend
git clone https://github.com/himanshudhimanux/school_erp_web.git web
```

## 5. Configure the API

```bash
cd /opt/school-erp/backend
cp .env.example .env && chmod 600 .env
nano .env
```

Production values:

| Setting | Value |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | `5000` (only Nginx talks to it) |
| `MONGODB_URI` | from step 3, with the database name |
| `JWT_ACCESS_SECRET` | `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"` |
| `DATA_ENCRYPTION_KEY` | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. **Back this up.** Without it, the stored Razorpay keys cannot be decrypted. |
| `APP_URL` | `https://erp.yourschool.in` (used in email links) |
| `CORS_ORIGINS` | `https://erp.yourschool.in` |
| `TRUST_PROXY` | `1` (behind Nginx, so rate limits see the real visitor IP) |
| `REQUIRE_TRANSACTIONS` | `true` |
| `RESEND_API_KEY`, `MAIL_FROM` | Resend API key and a sender on a domain verified in Resend (needed for account set-up and password-reset emails) |
| `PUBLIC_API_URL` | `https://erp.yourschool.in` (Twilio delivery receipts) |
| `TWILIO_*`, `FCM_SERVICE_ACCOUNT` | optional, see the README |

The server **refuses to start** if the production setup is unsafe. Examples:
- a missing or short encryption key;
- a placeholder JWT secret;
- insecure cookies.

It prints a warning for other gaps, such as no email provider or `TRUST_PROXY=0`.

## 6. First start

```bash
cd /opt/school-erp/backend
npm ci --omit=dev
npm run db:indexes                     # creates all indexes (production does not auto-create them)
pm2 start deploy/ecosystem.config.cjs --env production
pm2 save && pm2 startup systemd        # run the command it prints, so PM2 starts on boot
curl -s http://127.0.0.1:5000/api/v1/health
```

PM2 starts one API process per CPU core; only the first one runs scheduled jobs. Create the platform administrator once:

```bash
npm run create-superadmin -- you@yourschool.in "Your Name" --print-link
```

Open the printed link (valid for 72 hours) to set the password. Without `--print-link`, use "Forgot password" on the sign-in page, which needs Resend email.

Do **not** run `npm run seed` in production. It creates demo schools and accounts that share a known password.

## 7. Web app

```bash
cd /opt/school-erp/web
npm ci && npm run build
rsync -a --delete dist/ /var/www/school-erp/
```

The web app calls `/api/v1` on its own domain, so no build-time API URL is needed.

## 8. Nginx and HTTPS

```bash
cd /opt/school-erp/backend
sudo cp deploy/nginx/school-erp.conf /etc/nginx/sites-available/school-erp
sudo sed -i 's/erp.example.com/erp.yourschool.in/g' /etc/nginx/sites-available/school-erp
sudo ln -s /etc/nginx/sites-available/school-erp /etc/nginx/sites-enabled/ && sudo rm -f /etc/nginx/sites-enabled/default
sudo apt -y install certbot python3-certbot-nginx
sudo certbot --nginx -d erp.yourschool.in --redirect -m you@yourschool.in --agree-tos
sudo nginx -t && sudo systemctl reload nginx
```

The site config:
- adds security headers, including a Content-Security-Policy that only allows Razorpay Checkout as outside code;
- caches build assets for a year but never caches `index.html`;
- adds a second rate limit on sign-in in front of the API's own limit.

Certbot renews the certificate automatically.

## 9. Integrations

| Provider | What to set |
|---|---|
| **Razorpay** (each school, in Fee Setup → Online payments) | Webhook URL `https://erp.yourschool.in/api/v1/webhooks/razorpay/<schoolId>` (shown on that page), events `payment.captured` and `order.paid` |
| **Twilio** | Nothing to set in the Twilio console. Each message carries `PUBLIC_API_URL/api/v1/webhooks/twilio/status` as its status callback. |
| **Firebase** | Download the service-account JSON to `/opt/school-erp/secrets/fcm.json` (`chmod 600`) and set `FCM_SERVICE_ACCOUNT=/opt/school-erp/secrets/fcm.json` |
| **Android app** | Set the release API URL in `mobile/src/config.js` (`https://erp.yourschool.in/api/v1`) before building the release APK |

## 10. Backups

```bash
sudo mkdir -p /var/backups/school-erp && sudo chown erp:erp /var/backups/school-erp
chmod +x /opt/school-erp/backend/deploy/scripts/*.sh
/opt/school-erp/backend/deploy/scripts/backup-mongo.sh          # test it once by hand
crontab -e
# 30 2 * * * /opt/school-erp/backend/deploy/scripts/backup-mongo.sh >> /var/log/school-erp-backup.log 2>&1
```

- Local archives are kept for 14 days (`BACKUP_KEEP_DAYS`).
- **Keep an off-site copy.** Set up rclone (for example Cloudflare R2 or Google Drive) and set `BACKUP_RCLONE_REMOTE=r2:erp-backups`.
- On Atlas M10+, also turn on Cloud Backup with point-in-time restore.
- **Back up separately:** the `.env` file (above all `DATA_ENCRYPTION_KEY` and `JWT_ACCESS_SECRET`) and the Firebase JSON. Database dumps don't contain them.

**Test a restore every month** into a scratch database:

```bash
deploy/scripts/restore-mongo.sh /var/backups/school-erp/school-erp-school_erp-<stamp>.archive.gz "mongodb://.../school_erp_restore_test"
```

## 11. Updating

```bash
cd /opt/school-erp/backend
WEB_DIR=/opt/school-erp/web deploy/scripts/deploy.sh
```

The script runs these steps and stops at the first error:
1. Pulls `main`.
2. Installs production dependencies.
3. Creates any new indexes.
4. Reloads PM2 without downtime.
5. Checks `/health`, and prints a rollback command if the check fails.
6. Builds the web app and publishes it, so pages already open keep working.

Run `npm test` before deploying. Tests need a replica set for the fee tests; see the README.

## 12. Monitoring

| What | How |
|---|---|
| Is it up? | `GET https://erp.yourschool.in/api/v1/health` returns 200 with `db: up`. Point UptimeRobot or Better Uptime at it. |
| Processes and memory | `pm2 status`, `pm2 monit` (processes restart automatically above 600 MB) |
| Logs | `pm2 logs school-erp-api` (JSON, one line per request, with request ids); Nginx logs in `/var/log/nginx/` |
| Failed notifications | Web app → Communication → Notification history (filter: Failed) |
| Disk | `df -h`: logs rotate and backups are pruned, but watch `/var/backups` |

## Security checklist

- [ ] Only ports 22, 80 and 443 are open (`ufw status`); MongoDB is not reachable from the internet.
- [ ] SSH uses keys only; root login is disabled.
- [ ] `.env` is `chmod 600` and is not in git.
- [ ] `JWT_ACCESS_SECRET` and `DATA_ENCRYPTION_KEY` are random and backed up somewhere safe.
- [ ] `TRUST_PROXY=1`, `REQUIRE_TRANSACTIONS=true`, HTTPS-only URLs (the server warns otherwise).
- [ ] No demo data or demo accounts in production.
- [ ] Backups run nightly, an off-site copy exists, and a restore has been tested.
- [ ] `sudo apt install unattended-upgrades` for OS security updates; `npm audit --omit=dev` on each update.

## Capacity

The load test used one school with 2,400 students, 48,000 attendance records and 9,600 invoices. It ran 50 concurrent clients against a **single** API process, with MongoDB, the API and the load generator all sharing one 4-thread 2013 desktop CPU:
- zero errors;
- about 55 requests a second of mixed staff, teacher and parent traffic;
- median 160 ms and p90 300 ms at 10 concurrent clients.

The database was the bottleneck. On a VPS with Atlas, the API gets its own cores and PM2 runs one process per core, so expect noticeably more.

To repeat the test on a staging copy (never production):

```bash
MONGODB_URI=<staging-uri> npm run seed:load
RATE_LIMIT_PER_MINUTE=1000000 AUTH_RATE_LIMIT_PER_15_MIN=100000 JOBS_ENABLED=false npm start
npm run load-test -- --connections=50 --duration=20
```
