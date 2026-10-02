# Neo Bank — نيو بنك (Core Banking + Digital Portal)

> **Demo / educational system with fictional data.** It is a complete, working core-banking stack, but it is **not licensed, certified or connected to any real payment network.** See [Going live](#going-live--before-any-real-use) before any real use.

**[English](#english)** · **[العربية](#العربية)**

---

## English

### What is it
A full banking system for an Egyptian context (EGP default, plus USD / EUR / SAR), Arabic RTL by default with an English toggle:

* **Staff Core Banking** — `/staff`: customers & KYC, accounts, teller & vault, cash-counter devices, transfers & clearing, loans, term deposits, cards and every card channel (ATM / POS / e-commerce with 3-D Secure / contactless / refunds & chargebacks), ATMs (cassettes, replenishment, reconciliation), disputes, AML, maker-checker approvals, GL & journals, reports, End-of-Day, CRM tickets, staff/branch admin, audit log.
* **Customer Digital Portal** — `/portal`: login with password + SMS OTP, self-onboarding, accounts & statements (CSV/PDF), transfers (OTP), beneficiaries, bill payments, cards (freeze, per-channel toggles & limits, PIN change, live transactions, disputes, demo 3-D Secure checkout), loans, term deposits, notifications, support tickets, profile & password.

**Stack:** Next.js 15 (App Router) · TypeScript · Tailwind v4 · PostgreSQL 17 · Prisma 6 · zod · vitest.

### Architecture highlights
* **Double-entry ledger** (`src/server/ledger.ts`) — every money movement is one balanced journal entry; balances are maintained under row locks (`SELECT … FOR UPDATE`); DB triggers enforce balanced entries (deferred constraint) and make posted lines/entries and the audit log immutable (no UPDATE/DELETE).
* **Idempotency** on every posting (unique `idempotencyKey` + request hash; replays return the original; key reuse with a different payload is rejected).
* **Sub-ledgers** (customer accounts, tills, loans) reconcile to control GL accounts; the reconciliation runs in every EOD.
* **Security:** bcrypt passwords with policy, lockout, optional TOTP 2FA for staff, server-side sessions (HttpOnly, SameSite=Lax, Secure), CSRF origin checks, rate limiting, RBAC with 10 roles checked server-side in every API and page, branch scoping, maker-checker, append-only audit log, customer data isolation.
* **Unified card authorization** (`src/server/services/card-auth.ts`): authorize → hold → capture/settle (full or partial) → release (void / expired by EOD) → reverse (advice or timeout) → refund (partial/full, idempotent, never above captured) → dispute/chargeback. Every event carries the channel (`ATM`, `POS`, `ECOM`, `CONTACTLESS`) and merchant name / MCC / country, posts to the ledger in real time, shows instantly in staff (`/staff/card-auths`) and portal (`/portal/cards`) views (auto-refresh) and notifies the customer.
* **ISO 8583 switch adapter** (`src/server/switch/*`, JSON-encoded) with an issuer endpoint `/api/switch/iso8583` (shared key), timeout → automatic reversal, duplicate-STAN idempotency, ATM & POS simulators, mock HSM (ISO 9564 format-0 PIN blocks, PVV — PINs are never stored), mock 3-D Secure ACS (OTP).
* **Cash-counter adapter** (`src/server/devices/cash-counter.ts`): `SIMULATOR`, `TCP` and `SERIAL`/`USB` (stub) drivers. A count session is bound single-use to a teller deposit/withdrawal, till/vault balancing, ATM replenishment or ATM EOD count; counterfeits are refused; mismatches are rejected.

### Quick start (development)
Requirements: Node 20+, PostgreSQL 15+ (17 used), `psql`/`pg_dump` client tools.

```bash
# 1. database (once)
sudo -u postgres psql -c "CREATE ROLE neobank LOGIN PASSWORD 'change-me' CREATEDB;"
sudo -u postgres psql -c "CREATE DATABASE neobank OWNER neobank;"
sudo -u postgres psql -c "CREATE DATABASE neobank_test OWNER neobank;"

# 2. configuration
cp .env.example .env          # set DATABASE_URL, TEST_DATABASE_URL, SESSION_SECRET (openssl rand -hex 32)

# 3. install, migrate, seed
npm install                   # also runs prisma generate
npm run db:migrate            # prisma migrate deploy
npm run db:seed               # ~1 minute: 150 days of activity through the real engines + EOD each day

# 4. run
npm run dev                   # http://localhost:3100   (staff: /staff, customers: /portal)
# or production mode:
npm run build && COOKIE_SECURE=false npm start   # http://localhost:3101
```

Re-seed a development database: `SEED_RESET=1 npm run db:seed` (empties all tables first; refused when `NODE_ENV=production`) or `npm run db:reset` (Prisma: drop, re-migrate and seed).

In development the console OTP provider prints every OTP to the server log (`[DEV OTP] …`) and, with `DEMO_SHOW_OTP=1`, the UI also shows the code. Neither happens in production.

### Demo credentials (fictional)
| Who | Username | Password | Scope |
|---|---|---|---|
| Super admin | `admin` | `NeoBank@2026` | head office |
| Branch managers | `mgr.cairo`, `mgr.alex`, `mgr.giza` | `NeoBank@2026` | own branch |
| Tellers | `teller.cairo`, `teller.cairo2`, `teller.alex`, `teller.giza` | `NeoBank@2026` | own branch + own till |
| Customer service | `cs.cairo`, `cs.alex`, `cs.giza` | `NeoBank@2026` | own branch |
| Credit officers | `credit.cairo`, `credit.alex` | `NeoBank@2026` | own branch |
| Credit manager | `credit.manager` | `NeoBank@2026` | head office |
| Compliance (AML) | `compliance` | `NeoBank@2026` | head office |
| Operations | `ops` | `NeoBank@2026` | head office |
| Finance | `finance` | `NeoBank@2026` | head office |
| Auditor (read-only) | `auditor` | `NeoBank@2026` | head office |
| Portal customer | `ahmed.hassan` (Cairo) | `Portal@2026` | + OTP (see server log / on-screen in dev) |
| Portal customer | `mona.ali` (Cairo) | `Portal@2026` | + OTP |
| Portal customer | `khaled.ibrahim` (Alexandria) | `Portal@2026` | + OTP |

Seeded cards PIN: **2580** (used by the ATM/POS simulators). Switch key in dev: `dev-switch-key-change-me`.

**What the seed contains** (all posted through the real services): 3 branches (0101 Cairo Downtown, 0201 Alexandria Smouha, 0301 Giza Dokki) with vaults in 4 currencies and teller tills; 18 staff covering all 10 roles; 30 customers (27 individuals, 3 companies) + 3 KYC-pending applicants; ~56 accounts (current/savings/FX/term); salaries, cash deposits/withdrawals, internal & external transfers (clearing batches settled), bill payments, savings sweeps; 24 cards with ~690 authorizations across ATM (own & other banks), POS, e-commerce (3-D Secure), contactless, with captures, partial captures, expired holds, refunds, declines, 2 disputes; 4 ATMs with cassettes, replenishments; 4 cash counters; 8 disbursed loans (one 30+ DPD, one NPL 90+), 2 applications awaiting decision; 6 term deposits (one matured); AML alerts; pending approvals (KYC, large cash, account freeze); tickets; and **EOD run for each of the 150 days** (interest accrual/capitalization, loan collection, penalties, aging, hold expiry, fees, snapshots, reconciliation).

### Roles & permissions
Roles: ADM = SUPER_ADMIN, BM = BRANCH_MANAGER, TLR = TELLER, CS = CUSTOMER_SERVICE, CO = CREDIT_OFFICER, CM = CREDIT_MANAGER, CMP = COMPLIANCE_OFFICER, OPS = OPERATIONS, FIN = FINANCE, AUD = AUDITOR. **Branch-scoped:** BM, TLR, CS, CO (they only see/act on their branch). Source of truth: `src/server/rbac.ts`.

| Permission | ADM | BM | TLR | CS | CO | CM | CMP | OPS | FIN | AUD |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `dashboard.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `customer.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `customer.create` | ✓ | ✓ |  | ✓ |  |  |  |  |  |  |
| `customer.update` | ✓ | ✓ |  | ✓ |  |  |  |  |  |  |
| `kyc.approve` | ✓ | ✓ |  |  |  |  | ✓ |  |  |  |
| `account.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `account.open` | ✓ | ✓ |  | ✓ |  |  |  |  |  |  |
| `account.status` | ✓ | ✓ |  | ✓ |  |  | ✓ | ✓ |  |  |
| `cash.deposit` | ✓ | ✓ | ✓ |  |  |  |  |  |  |  |
| `cash.withdraw` | ✓ | ✓ | ✓ |  |  |  |  |  |  |  |
| `till.read` | ✓ | ✓ | ✓ |  |  |  |  | ✓ | ✓ | ✓ |
| `till.operate` | ✓ | ✓ | ✓ |  |  |  |  |  |  |  |
| `till.manage` | ✓ | ✓ |  |  |  |  |  |  |  |  |
| `transfer.create` | ✓ | ✓ | ✓ |  |  |  |  | ✓ |  |  |
| `clearing.manage` | ✓ |  |  |  |  |  |  | ✓ |  |  |
| `loan.read` | ✓ | ✓ |  | ✓ | ✓ | ✓ |  |  | ✓ | ✓ |
| `loan.apply` | ✓ | ✓ |  | ✓ | ✓ |  |  |  |  |  |
| `loan.recommend` | ✓ |  |  |  | ✓ |  |  |  |  |  |
| `loan.approve` | ✓ |  |  |  |  | ✓ |  |  |  |  |
| `loan.disburse` | ✓ |  |  |  |  | ✓ |  |  |  |  |
| `loan.repay` | ✓ | ✓ | ✓ |  | ✓ |  |  |  |  |  |
| `deposit.open` | ✓ | ✓ |  | ✓ |  |  |  |  |  |  |
| `card.read` | ✓ | ✓ |  | ✓ |  |  |  | ✓ |  | ✓ |
| `card.manage` | ✓ | ✓ |  | ✓ |  |  |  | ✓ |  |  |
| `card.dispute` | ✓ | ✓ |  | ✓ |  |  |  | ✓ |  |  |
| `atm.read` | ✓ | ✓ | ✓ | ✓ |  |  |  | ✓ |  | ✓ |
| `atm.manage` | ✓ | ✓ |  | ✓ |  |  |  | ✓ |  |  |
| `fee.manage` | ✓ |  |  |  |  |  |  |  | ✓ |  |
| `aml.read` | ✓ |  |  |  |  |  | ✓ |  |  | ✓ |
| `aml.manage` | ✓ |  |  |  |  |  | ✓ |  |  |  |
| `gl.read` | ✓ |  |  |  |  |  |  |  | ✓ | ✓ |
| `journal.read` | ✓ | ✓ |  |  |  |  | ✓ | ✓ | ✓ | ✓ |
| `journal.manual` | ✓ |  |  |  |  |  |  |  | ✓ |  |
| `journal.reverse` | ✓ |  |  |  |  |  |  |  | ✓ |  |
| `report.read` | ✓ | ✓ |  |  | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `eod.run` | ✓ |  |  |  |  |  |  | ✓ | ✓ |  |
| `approval.read` | ✓ | ✓ |  | ✓ |  |  | ✓ | ✓ | ✓ | ✓ |
| `approval.decide` | ✓ | ✓ |  |  |  |  | ✓ | ✓ | ✓ |  |
| `audit.read` | ✓ |  |  |  |  |  | ✓ |  |  | ✓ |
| `staff.read` | ✓ | ✓ |  |  |  |  |  |  |  | ✓ |
| `staff.manage` | ✓ |  |  |  |  |  |  |  |  |  |
| `branch.manage` | ✓ |  |  |  |  |  |  |  |  |  |
| `ticket.read` | ✓ | ✓ |  | ✓ |  |  | ✓ | ✓ |  | ✓ |
| `ticket.manage` | ✓ | ✓ |  | ✓ |  |  |  | ✓ |  |  |


**Maker-checker** (the maker can never approve their own request; each request is decided once, under a row lock):

| Request | Checker roles |
|---|---|
| KYC approval (new customer) | ADM, BM (same branch), CMP |
| Account status change (freeze/unfreeze/close) | ADM, BM, CMP, OPS |
| Manual journal, journal reversal | ADM, FIN |
| Large cash withdrawal (≥ EGP 250,000 equivalent) | ADM, BM |
| Card unblock | ADM, BM, OPS |
| Loan approval | four-eyes: applicant → recommender (CO) → approver (CM or ADM), all different people |

### Staff routes (`/staff`)
`/staff/login` · `/staff` dashboard · `/staff/customers` (+`/[id]`: KYC docs, risk, digital access, open account, card, loan, TD) · `/staff/accounts` (+`/[id]` statement, status) · `/staff/teller` (deposit / withdrawal with cash-counter pull, till balancing) · `/staff/tills` (vault & tills, cash moves, vault EOD balancing) · `/staff/devices` (cash counters) · `/staff/transfers` (transfers, clearing batches) · `/staff/loans` (+`/[id]` schedule, decision, disbursement, repayment) · `/staff/deposits` · `/staff/cards` · `/staff/card-auths` (live authorizations, POS/ECOM/contactless simulator, capture/release/reverse/refund) · `/staff/disputes` · `/staff/atms` (cassettes, replenish, reconcile, status, ATM simulator) · `/staff/aml` (alerts, cases) · `/staff/approvals` · `/staff/journals` (journals, trial balance, manual journal) · `/staff/reports` (+`/[name]`) · `/staff/eod` · `/staff/tickets` (+`/[id]`) · `/staff/admin` (staff, permission matrix, branches, fees) · `/staff/audit` · `/staff/security` (password, TOTP 2FA).

### Portal routes (`/portal`)
`/portal/login` · `/portal/onboarding` · `/portal` (home) · `/portal/accounts/[id]` · `/portal/transfers` · `/portal/beneficiaries` · `/portal/bills` · `/portal/cards` · `/portal/loans` · `/portal/deposits` · `/portal/notifications` · `/portal/tickets` · `/portal/profile`.

### Reports
Trial balance, GL detail, balance sheet, income statement, GL ↔ sub-ledger reconciliation, account statements (screen, CSV, PDF), loan portfolio & quality (aging buckets, NPL ratio), deposits, AML, teller cash & tills, daily transactions, ATM (cash position, cassettes, withdrawals, reconciliations), card activity by channel. `GET /api/staff/reports/<name>` (`balance-sheet`, `income-statement`, `trial-balance`, `reconcile`, `loan-portfolio`, `deposits`, `teller-cash`, `daily`, `aml`, `atm`, `cards`, `gl`).

### API endpoints
All staff APIs require the `nb_staff` session cookie and the listed permission; all portal APIs require the `nb_portal` cookie and are scoped to the logged-in customer. State-changing requests must come from the app origin (CSRF check). Money amounts are decimal strings (`"1500.00"`); responses use minor units as strings for bigint.

| Endpoint | Methods |
|---|---|
| `/api/health` | GET |
| `/api/portal/accounts/[id]` | GET |
| `/api/portal/accounts/[id]/statement` | GET |
| `/api/portal/accounts` | GET |
| `/api/portal/auth/login` | POST |
| `/api/portal/auth/logout` | POST |
| `/api/portal/auth/verify` | POST |
| `/api/portal/beneficiaries/[id]` | DELETE |
| `/api/portal/beneficiaries` | GET POST |
| `/api/portal/bills/confirm` | POST |
| `/api/portal/bills` | GET |
| `/api/portal/bills/start` | POST |
| `/api/portal/branches` | GET |
| `/api/portal/cards/[id]` | POST |
| `/api/portal/cards/[id]/simulate` | POST |
| `/api/portal/cards/[id]/transactions` | GET |
| `/api/portal/cards/disputes` | POST |
| `/api/portal/cards` | GET |
| `/api/portal/deposits` | GET POST |
| `/api/portal/loans` | GET POST |
| `/api/portal/me` | GET |
| `/api/portal/notifications` | GET POST |
| `/api/portal/onboarding/start` | POST |
| `/api/portal/onboarding/verify` | POST |
| `/api/portal/profile/password` | POST |
| `/api/portal/profile` | PATCH |
| `/api/portal/tickets/[id]` | POST |
| `/api/portal/tickets` | GET POST |
| `/api/portal/transfers/confirm` | POST |
| `/api/portal/transfers` | GET |
| `/api/portal/transfers/start` | POST |
| `/api/staff/accounts/[id]` | GET |
| `/api/staff/accounts/[id]/statement` | GET |
| `/api/staff/accounts/[id]/status` | POST |
| `/api/staff/accounts` | GET POST |
| `/api/staff/aml/alerts/[id]` | POST |
| `/api/staff/aml/alerts` | GET |
| `/api/staff/aml/cases/[id]` | GET POST |
| `/api/staff/aml/cases` | GET POST |
| `/api/staff/approvals/[id]` | POST |
| `/api/staff/approvals` | GET |
| `/api/staff/atms/[id]` | POST |
| `/api/staff/atms` | GET POST |
| `/api/staff/atms/simulate` | POST |
| `/api/staff/audit` | GET |
| `/api/staff/auth/login` | POST |
| `/api/staff/auth/logout` | POST |
| `/api/staff/auth/me` | GET |
| `/api/staff/auth/password` | POST |
| `/api/staff/auth/totp` | POST |
| `/api/staff/branches` | GET POST |
| `/api/staff/card-auths/[id]` | POST |
| `/api/staff/card-auths` | GET |
| `/api/staff/cards/[id]` | POST |
| `/api/staff/cards` | GET POST |
| `/api/staff/cards/simulate` | POST |
| `/api/staff/clearing/[id]` | POST |
| `/api/staff/clearing` | GET |
| `/api/staff/customers/[id]/digital-access` | POST |
| `/api/staff/customers/[id]/documents` | POST |
| `/api/staff/customers/[id]/risk` | POST |
| `/api/staff/customers/[id]` | GET PATCH |
| `/api/staff/customers/[id]/term-deposits` | POST |
| `/api/staff/customers` | GET POST |
| `/api/staff/devices/count` | POST |
| `/api/staff/devices` | GET POST |
| `/api/staff/disputes/[id]` | POST |
| `/api/staff/disputes` | GET POST |
| `/api/staff/eod` | GET POST |
| `/api/staff/fees` | GET PATCH |
| `/api/staff/journals/[id]/reverse` | POST |
| `/api/staff/journals/manual` | POST |
| `/api/staff/journals` | GET |
| `/api/staff/loans/[id]` | GET POST |
| `/api/staff/loans` | GET POST |
| `/api/staff/reports/[name]` | GET |
| `/api/staff/staff/[id]` | PATCH |
| `/api/staff/staff` | GET POST |
| `/api/staff/teller/deposit` | POST |
| `/api/staff/teller/withdraw` | POST |
| `/api/staff/tickets/[id]` | POST |
| `/api/staff/tickets` | GET |
| `/api/staff/tills` | GET POST |
| `/api/staff/transfers` | GET POST |
| `/api/switch/iso8583` | POST |


### End-of-Day (EOD)
`npm run eod` (today, Africa/Cairo) or `npm run eod -- 2026-10-01`, or from `/staff/eod` (OPS/ADM). Steps, in order:
1. Deposit interest accrual (Actual/365, savings & TDs; fractional accrual tracked, whole minor units posted Dr 5010 / Cr 2200), month-end capitalization, TD maturities (principal + interest paid out, TD closed).
2. Loans: auto-collect due instalments from the repayment account, penalty interest on overdue amounts, DPD and classification (CURRENT, DPD 1-30, 31-60, 61-90, NPL 90+).
3. Release of expired card holds (7 days).
4. Month-end maintenance fee (fees engine).
5. Dormancy (365 days without activity).
6. Balance snapshots.
7. Reconciliation (TB balanced, sub-ledgers = control GL accounts). A break marks the run FAILED. A date can complete only once.

Cron (server time Africa/Cairo): `30 23 * * * cd /opt/neo-bank-system && npm run eod >> /var/log/neobank-eod.log 2>&1`.

### Backup & restore
```bash
scripts/backup.sh                        # pg_dump custom format → ./backups/neobank-YYYYMMDD-HHMMSS.dump + .sha256, retention 30 days
BACKUP_DIR=/var/backups/neobank RETENTION_DAYS=60 scripts/backup.sh
# cron, daily 01:30 after EOD:
30 1 * * * cd /opt/neo-bank-system && BACKUP_DIR=/var/backups/neobank scripts/backup.sh >> /var/log/neobank-backup.log 2>&1
# restore into a NEW empty database, verify (trial balance / reconcile report), then switch DATABASE_URL:
createdb -O neobank neobank_restore
scripts/restore.sh backups/neobank-20261002-013000.dump postgresql://neobank:...@localhost:5432/neobank_restore
```
Production: also enable WAL archiving / PITR (e.g. pgBackRest) and keep encrypted off-site copies; test restores regularly.

### Production deployment (Docker)
```bash
cp .env.example .env.production   # set POSTGRES_PASSWORD, SESSION_SECRET, SWITCH_API_KEY, DOMAIN, APP_URL, OTP_PROVIDER=sms-webhook + SMS_WEBHOOK_*
docker compose --env-file .env.production up -d --build
```
* `Dockerfile` — multi-stage build, non-root user, `tini`, health check on `/api/health`; on start it runs **`npx prisma migrate deploy`** then `next start`.
* `docker-compose.yml` — `db` (PostgreSQL 17, private network), `app`, `proxy` (Caddy with automatic HTTPS/Let's Encrypt, HSTS — `deploy/Caddyfile`), `scheduler` (nightly EOD 23:30 and backup 01:30).
* Without Docker: `npm ci && npm run build && npx prisma migrate deploy && npm start` behind nginx/Caddy terminating TLS (forward `X-Forwarded-For`/`X-Forwarded-Proto`), with `COOKIE_SECURE=true`.
* Never run the seed against production.

**Environment variables**

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection (Prisma) |
| `TEST_DATABASE_URL` | separate DB for `npm test` (wiped by the tests) |
| `SESSION_SECRET` | 32+ random bytes (hex) |
| `APP_URL` | public origin (CSRF origin check, links) |
| `COOKIE_SECURE` | `true` behind HTTPS (default in production); `false` only for local http |
| `OTP_PROVIDER` | `console` (dev) · `sms-webhook` (production) · `memory` (tests) |
| `SMS_WEBHOOK_URL`, `SMS_WEBHOOK_TOKEN` | SMS gateway webhook for OTPs |
| `DEMO_SHOW_OTP` | dev only: show OTP in UI (ignored in production) |
| `ALLOW_CONSOLE_OTP` | allow console OTP in production (testing only) |
| `SWITCH_API_KEY` | shared key for `/api/switch/iso8583` (required in production) |
| `SWITCH_TIMEOUT_MS` | switch timeout before auto-reversal (default 30000) |
| `HSM_MOCK_ZPK`, `HSM_MOCK_PVK` | mock-HSM keys (32+ chars) |
| `ALLOW_MOCK_HSM` | `1` to allow the mock HSM in production (demo only) |
| `DISABLE_RATE_LIMIT` | tests only |
| `PRISMA_LOG` | `query` for verbose SQL logging |

### Tests & quality gates
```bash
npm run lint && npm run typecheck && npm test && npm run build
# end-to-end smoke (server running with the seed):
COOKIE_SECURE=false ALLOW_CONSOLE_OTP=1 ALLOW_MOCK_HSM=1 SWITCH_API_KEY=smoke-key-123456 npm start > /tmp/neobank-start.log 2>&1 &
DATABASE_URL=... SWITCH_API_KEY=smoke-key-123456 SERVER_LOG=/tmp/neobank-start.log scripts/smoke.sh
```
71 automated tests (vitest, against a real PostgreSQL test DB): ledger balancing & immutability, reversal, sub-ledger reconciliation, transfer atomicity, no double-spend under concurrency, idempotency, insufficient funds, frozen/dormant/closed accounts, IBAN check digits, clearing; interest accrual & capitalization, amortization math, loan lifecycle with penalties & NPL aging; fees engine; AML alerts & cases; TD maturity; balance sheet / TB / reconciliation; ATM dispense/replenish/reconcile, timeout auto-reversal, duplicate STAN, other-bank fees, PIN tries; card hold/capture/partial/release/expiry/refund/over-refund/chargeback; 3-D Secure; contactless no-PIN limit; per-channel toggles & limits; cash-counter binding/mismatch/counterfeit/variance; RBAC (incl. HTTP 401/403 and CSRF), branch scoping, customer isolation, maker-checker, password policy, lockout, TOTP, single-use OTP, EOD double-run. The smoke script performs 70 checks with real logins for every role.

### Going live — before any real use
This repository is a demonstration. Operating a bank or payment service in Egypt requires, at minimum:
* **Central Bank of Egypt (CBE) licensing** and compliance with CBE regulations (KYC/e-KYC, digital banking & outsourcing rules, data residency), the Anti-Money Laundering law and EMLCU reporting (STR/CTR), consumer-protection rules.
* **PCI-DSS** certification of the card environment (this demo uses tokens, never real PANs; real card data requires a PCI-scoped vault/tokenization).
* **Real payment-network integration**: ATMs need a switch/processor connection (e.g. the national switch / card schemes) and the vendor's **NDC/DDC** protocol on the terminals, a **certified HSM** (PCI-HSM / FIPS 140-2 L3) for PIN, keys and cryptograms, EMV kernels and **network/scheme certification**; POS/e-commerce need an acquirer, a certified **EMV 3-D Secure 2.x ACS**, and scheme certification. Clearing (ACH/RTGS/InstaPay), bill payment aggregators and SMS gateways must be contracted and integrated (the adapters here are **MOCK**).
* **Cash-counter drivers** depend on the machine model and vendor protocol (Glory, Magner, Cassida…); the `SERIAL`/`USB` drivers here are stubs and the `TCP` driver expects a vendor bridge.
* An independent **security audit and penetration test**, secure SDLC, secrets management (HSM/KMS), WAF, monitoring/SIEM, DR site, BCP and regular restore tests.

### Known limitations
Arabic glyphs in generated PDF statements are not shaped (use the on-screen or CSV statement for Arabic); no FX conversion between currencies (transfers must be same-currency); loan interest income is recognised on a cash basis (at collection); the in-process simulators use an in-memory STAN counter; HSM, 3-D Secure, clearing, billers and the switch are mocks; serial/USB counter drivers are stubs; the immutability triggers block UPDATE/DELETE but not TRUNCATE (restrict DB privileges in production); AML alerts are not branch-scoped (compliance is a head-office function).

---

## العربية

### ما هو النظام
نظام بنكي متكامل لبيئة مصرية (الجنيه المصري افتراضياً مع الدولار واليورو والريال السعودي)، بالعربية ومن اليمين لليسار افتراضياً مع زر للتبديل إلى الإنجليزية:

* **النظام البنكي الأساسي للموظفين** — `/staff`: العملاء واعرف عميلك، الحسابات، الصرافين والخزينة، أجهزة عد النقدية، التحويلات والمقاصة، القروض، الودائع لأجل، البطاقات وجميع قنواتها (الصراف الآلي لبنكنا ولبنوك أخرى، نقاط البيع، الشراء عبر الإنترنت مع 3-D Secure، الدفع اللاتلامسي، الاسترداد والاعتراضات)، ماكينات الصراف الآلي (الكاسيتات، التغذية، المطابقة)، مكافحة غسل الأموال، الموافقات (المنشئ والمراجع)، دفتر الأستاذ والقيود، التقارير، إقفال نهاية اليوم، الشكاوى، إدارة الموظفين والفروع، سجل التدقيق.
* **بوابة العملاء الرقمية** — `/portal`: دخول بكلمة مرور ورمز OTP، فتح حساب ذاتي، الحسابات وكشوف الحساب (CSV/PDF)، التحويلات برمز OTP، المستفيدون، دفع الفواتير، البطاقات (تجميد، تفعيل/تعطيل كل قناة وحدودها، تغيير الرقم السري، العمليات لحظياً، الاعتراض، تجربة دفع إلكتروني)، القروض، الودائع، الإشعارات، الدعم، الملف الشخصي.

### التشغيل السريع
```bash
sudo -u postgres psql -c "CREATE ROLE neobank LOGIN PASSWORD 'change-me' CREATEDB;"
sudo -u postgres psql -c "CREATE DATABASE neobank OWNER neobank;"
sudo -u postgres psql -c "CREATE DATABASE neobank_test OWNER neobank;"
cp .env.example .env        # اضبط DATABASE_URL و TEST_DATABASE_URL و SESSION_SECRET
npm install
npm run db:migrate          # تطبيق الترحيلات (prisma migrate deploy)
npm run db:seed             # بيانات تجريبية لمدة 150 يوماً عبر المحركات الحقيقية مع إقفال يومي
npm run dev                 # http://localhost:3100  ← /staff للموظفين و /portal للعملاء
npm run build && COOKIE_SECURE=false npm start    # وضع الإنتاج على http://localhost:3101
```
إعادة تعبئة قاعدة التطوير: `SEED_RESET=1 npm run db:seed` (مرفوض في الإنتاج) أو `npm run db:reset`.
في بيئة التطوير تُطبع رموز OTP في سجل الخادم وتظهر على الشاشة عند `DEMO_SHOW_OTP=1` — ولا يحدث ذلك في الإنتاج.

### بيانات الدخول التجريبية (وهمية)
* **جميع الموظفين:** كلمة المرور `NeoBank@2026` — أسماء المستخدمين: `admin` (مدير النظام)، `mgr.cairo` / `mgr.alex` / `mgr.giza` (مديرو الفروع)، `teller.cairo` / `teller.cairo2` / `teller.alex` / `teller.giza` (صرافون)، `cs.cairo` / `cs.alex` / `cs.giza` (خدمة العملاء)، `credit.cairo` / `credit.alex` (مسؤولو ائتمان)، `credit.manager` (مدير الائتمان)، `compliance` (الالتزام ومكافحة غسل الأموال)، `ops` (العمليات)، `finance` (المالية)، `auditor` (المراجع — قراءة فقط).
* **العملاء:** `ahmed.hassan` و `mona.ali` و `khaled.ibrahim` — كلمة المرور `Portal@2026` ثم رمز OTP (من سجل الخادم أو على الشاشة في التطوير).
* **الرقم السري للبطاقات التجريبية:** `2580`.

### الأدوار والصلاحيات
عشرة أدوار (جدول الصلاحيات الكامل في القسم الإنجليزي أعلاه وفي `src/server/rbac.ts`). مدير الفرع والصراف وخدمة العملاء ومسؤول الائتمان مقيدون بفرعهم. مبدأ المنشئ والمراجع: لا يمكن لمنشئ الطلب اعتماده بنفسه، ويُبت في الطلب مرة واحدة فقط. اعتماد القرض يمر بثلاثة أشخاص مختلفين (مقدم الطلب ← الموصي ← المعتمد). السحب النقدي الكبير (250 ألف جنيه فأكثر) يحتاج موافقة مدير الفرع.

### مسارات الموظفين والعملاء
راجع القوائم في القسم الإنجليزي ( `/staff/...` و `/portal/...` ) وجدول واجهات البرمجة `API`. كل واجهات الموظفين تتطلب جلسة `nb_staff` والصلاحية المناسبة، وكل واجهات العملاء تتطلب جلسة `nb_portal` وتقتصر على بيانات العميل نفسه.

### قنوات البطاقات
مسار موحد: تفويض ← حجز المبلغ ← تسوية (كاملة أو جزئية) ← فك الحجوزات المنتهية في الإقفال اليومي ← عكس العملية ← استرداد ← اعتراض/استرجاع. كل حدث يحمل القناة (ATM / POS / ECOM / CONTACTLESS) وبيانات التاجر (الاسم، كود النشاط MCC، الدولة)، ويُقيد فوراً في دفتر الأستاذ، ويظهر لحظياً للموظفين وللعميل، ويُرسل إشعار للعميل. يستطيع العميل من البوابة تعطيل أي قناة (مثلاً الدفع عبر الإنترنت أو الاستخدام خارج مصر) وتحديد حد يومي لكل قناة.

### إقفال نهاية اليوم
`npm run eod` أو من صفحة `/staff/eod`: احتساب العائد اليومي على التوفير والودائع ورسملته آخر الشهر واستحقاق الودائع، تحصيل أقساط القروض وغرامات التأخير وتصنيف أيام التأخير والديون غير المنتظمة (أكثر من 90 يوماً)، فك حجوزات البطاقات المنتهية، رسوم الإدارة الشهرية، الحسابات الراكدة، لقطات الأرصدة، ومطابقة ميزان المراجعة مع الدفاتر المساعدة. لا يمكن إقفال نفس اليوم مرتين.

### النسخ الاحتياطي والاستعادة
`scripts/backup.sh` (pg_dump بصيغة مضغوطة مع بصمة SHA-256 والاحتفاظ 30 يوماً) — مثال cron يومي الساعة 1:30 صباحاً:
`30 1 * * * cd /opt/neo-bank-system && BACKUP_DIR=/var/backups/neobank scripts/backup.sh`
الاستعادة إلى قاعدة جديدة فارغة ثم التحقق ثم التحويل: `scripts/restore.sh <ملف> <رابط القاعدة>`.

### النشر للإنتاج
`docker compose --env-file .env.production up -d --build` — يشمل PostgreSQL والتطبيق ووكيل Caddy بشهادات HTTPS تلقائية ومجدولاً للإقفال اليومي والنسخ الاحتياطي. الحاوية تنفذ `npx prisma migrate deploy` قبل التشغيل. لا تشغّل بيانات التجربة على الإنتاج أبداً. متغيرات البيئة موضحة في الجدول الإنجليزي و `.env.example`.

### الاختبارات
`npm run lint && npm run typecheck && npm test && npm run build` — 71 اختباراً آلياً على قاعدة PostgreSQL حقيقية، بالإضافة إلى `scripts/smoke.sh` (70 فحصاً بتسجيلات دخول حقيقية).

### قبل أي استخدام حقيقي
هذا نظام تجريبي ببيانات وهمية. التشغيل الفعلي يتطلب: **ترخيص البنك المركزي المصري** والالتزام بتعليماته وقانون مكافحة غسل الأموال والإبلاغ لوحدة مكافحة غسل الأموال؛ **شهادة PCI-DSS** لبيئة البطاقات؛ **الربط الفعلي بشبكات الدفع**: ماكينات الصراف الآلي تحتاج سويتش/معالج دفع وبروتوكول **NDC/DDC** الخاص بالمورد و**وحدة HSM معتمدة** و**اعتماد الشبكة**، ونقاط البيع والتجارة الإلكترونية تحتاج بنكاً مستحوذاً وخدمة 3-D Secure معتمدة؛ والمقاصة والفواتير والرسائل النصية هنا **محاكاة (MOCK)**؛ **برامج تشغيل أجهزة عد النقدية** تعتمد على طراز الجهاز وبروتوكول المورد؛ و**تدقيق أمني واختبار اختراق** مستقل قبل الإطلاق.
