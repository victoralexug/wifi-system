# CLAUDE.md

This file guides Claude Code (claude.ai/code) when working in this repository.

## Project overview

**YourWiFi** (working name) is a paid Wi-Fi hotspot for a Nigerian neighbourhood with a Starlink uplink. A customer joins the Wi-Fi and the MikroTik hotspot redirects them to our portal. They sign in or create an account (phone + password, with an email for password resets), then buy a **time pass** (unlimited data) or a **data bundle** (e.g. 60 GB within 30 days) with Paystack. The backend creates a hotspot user on the router and the portal logs the device in. Access ends when the time **or** the bundle's data runs out, whichever comes first. Customers check data and time left on their account page.

See `README.md` for the architecture diagram and local setup, and `infra/README.md` for hardware, the router and tunnel setup, and the go-live checklist.

## Stack (decided)

| Layer | Choice |
| --- | --- |
| Monorepo | npm workspaces: `apps/api`, `apps/portal`, `apps/admin`, `packages/shared` |
| Backend | Node 22 + TypeScript, Express 5, Zod 4, Drizzle ORM, pino |
| Database | PostgreSQL in production. **PGlite** (embedded Postgres) when `DATABASE_URL` is unset, for dev and tests |
| Payments | **Paystack** (`PaystackProvider`), plus `MockPaymentProvider` for local dev |
| Email | SMTP through nodemailer (`SmtpMailService`), plus `MockMailService`, which logs reset links to the API console |
| Controller | **MikroTik RouterOS v7 REST API** (`MikrotikNetworkService`), plus `MockNetworkService`. Router model not yet purchased; any RouterOS ≥ 7.1 works |
| Router link | WireGuard: the router dials out to the VPS because Starlink uses CGNAT. The API reaches the router at 10.8.0.2 |
| Customer accounts | Sign in with phone number (normalized to +234…) + password (scrypt). Email (lowercased, unique) is required at sign-up and used only for password reset: a single-use link valid for 30 minutes, token stored as a SHA-256 hash and carried in the URL fragment. Older accounts without an email add one from the account page. Admins can still issue a one-time password (Customers page) as a fallback. No SMS. Signed-JWT httpOnly cookie `yw_customer` (SameSite=Lax, 30 days) |
| Router access | Each purchase gets an 8-char **voucher code**, used as hotspot username and password; `shared-users=1` |
| Portal | React 19 + Vite. No router or UI library, kept small for captive-portal phones |
| Admin | React 19 + Vite + React Router 7 + TanStack Query, served at `/admin/` |
| Tests | Vitest + Supertest against in-memory PGlite |

## Commands

```bash
npm install
npm run dev                    # api :4000 (tsx watch), portal :5173, admin :5174 (both proxy /api)
npm test                       # API test suite (~80 s; each test boots an in-memory PGlite)
npm run typecheck              # all workspaces
npm run build                  # portal, admin, then API (tsup → apps/api/dist)
npm run db:generate            # after editing apps/api/src/db/schema.ts: writes SQL to apps/api/drizzle/
npm run db:migrate | db:seed
npm run admin:create -- <email> <password>
```

Run one test file: `cd apps/api && npx vitest run test/flow.test.ts`. Migrations also run automatically when the API starts.

## Code map (apps/api/src)

- `config.ts`: Zod-validated env. **Production guards live here** (no mock drivers, including mail, Postgres required, no test keys).
- `orders/orders.service.ts`: `create`, **`confirmPayment`** (the only path from payment to access), `getStatus`, `reconcilePending`.
- `sessions/sessions.service.ts`: `createForOrder`, `provision`, `retryPending`, **`syncUsage`** (data-bundle enforcement), `expireDue`, `revoke`, `retry`.
- `customers/`: customer auth (`/api/auth/register|login|logout|forgot-password|reset-password`) and account API (`/api/me`, `/api/me/sessions`, `/api/me/password`, `/api/me/email`).
- `mail/`: the `MailService` interface, SMTP, and mock.
- `lib/auth.ts`: shared signed-cookie sessions. Admin and customer tokens use different audiences and cookies, so neither is accepted as the other.
- `payments/`: the `PaymentProvider` interface, Paystack, and mock.
- `network/`: the `NetworkService` interface, MikroTik REST, and mock. **All router access goes through this interface.**
- `routes/`: public (`/api/plans`; `/api/orders*` need a signed-in customer and only return their own orders; `/api/sessions/lookup`), webhook (`/api/webhooks/paystack`), dev (`/api/dev/mock-pay`, `/api/dev/mock-usage/:code`, mock drivers only).
- `admin/`: JWT cookie auth (`yw_admin`, SameSite=Strict) and the admin API.
- `jobs.ts`: interval loops. Session retry and expiry every `JOB_INTERVAL_SECONDS`, Paystack reconcile, router health.

## Non-negotiable rules

- **Access is granted only by `confirmPayment`.** It calls Paystack's verify API and checks the status, amount and currency against the order. Webhooks, the "check my payment" button and the reconcile job all route through it. Never grant access from the frontend, the callback URL or the webhook body alone.
- **Idempotency is enforced in the database.** The `pending|failed → success` update is conditional, and `access_sessions.order_id` is unique. Keep it that way when touching the order flow.
- **Amount or currency mismatch → `flagged`**, never a session.
- **Webhook signature:** HMAC-SHA512 of the *raw* body with the secret key, compared timing-safe against `x-paystack-signature`. The webhook router is mounted before `express.json()` and must stay there.
- **Money is integer kobo.** Admin and portal UIs convert to and from naira only at the edges.
- **Sessions snapshot the plan** (name, duration, rate, cap) at purchase. Plan edits never affect paid sessions. Plans are deactivated, never deleted.
- **NetworkService implementations must be idempotent.** Granting an existing user updates it, and revoking a missing one succeeds, because jobs retry.
- **Expiry is wall-clock** (`expires_at`), enforced by the backend job. RouterOS `limit-uptime` is only a backstop.
- **Data bundles are enforced by the backend** (`syncUsage`, every `JOB_INTERVAL_SECONDS`). RouterOS only adds traffic to a hotspot user's `bytes-in`/`bytes-out` at logout, so live usage = user totals + `/ip/hotspot/active` counters, and `limit-bytes-total` alone can be overrun during a long session. Usage accumulates by *deltas* against `controller_bytes`, so a counter reset never lowers it. Overrun is bounded by one poll interval of traffic.
- `session_status`: `expired` means time ran out; `exhausted` means data ran out. Keep them distinct in the UI.
- Data sizes are binary (1 GB = 1024 MB), matching RouterOS. Plans store `data_cap_mb`; the admin form takes GB.
- Customer login rate limits count **failed attempts only**, keyed per phone or customer (never per IP; see the Starlink note). Reset-email requests count every request, keyed per email.
- `/api/auth/forgot-password` always answers 204, whether or not the email has an account.
- **Secrets stay in `apps/api/.env`.** Keep `.env.example` in sync when adding config.
- **The portal posts voucher codes only to `VITE_HOTSPOT_LOGIN_HOSTS`** (see `safeLoginUrl`), never to an arbitrary `link-login-only` from the URL.
- Timestamps are stored in UTC and shown in Africa/Lagos time (UTC+1, no DST). In SQL, convert `timestamptz` with `at time zone 'UTC'` before shifting. Never rely on the DB session time zone.
- All customers behind one Starlink share a single public IP, so keep per-IP rate limits generous.

## Design system

Based on `design guide/` (the "5 Rules of Clean Design" slides). Tokens live at the top of `apps/portal/src/styles.css` and `apps/admin/src/styles.css`. Use the tokens; never hard-code colours or sizes.

- **Colours (limit them):** primary indigo `#3f4482`, secondary lavender `#aeb3da`, neutral grey `#e4e4e4`, background `#f6f9fa`, text `#161b26`. In dark mode lavender becomes the primary. Red is for errors only. The admin dashboard may also use good/warning/critical status colours, always with an icon and a label.
- **Hierarchy:** one filled indigo pill (`.btn.primary`) per screen; every other action is a grey pill (`.btn`). In the portal, only the primary CTA is sticky.
- **Typography:** Inter, self-hosted through `@fontsource-variable/inter`. Never use Google Fonts: the walled garden would have to allow it. The portal loads only the Latin subset. There are four sizes, `--fs-display`, `--fs-title`, `--fs-body` and `--fs-small`, and weights 400, 500 and 600.
- **Whitespace:** the 8px scale `--s1`…`--s6`, centred headings with muted subtitles, and borderless surface cards with 20px radius (16px in admin).
- **Chart bars:** `#4a50a0` in light mode and `#6e76d6` in dark. Both pass the dataviz palette validator; the brand `#3f4482` is too dark for marks.

## Captive portal constraints

- The walled garden (in `infra/mikrotik/yourwifi-setup.rsc`) must allow the portal host and Paystack (`checkout.paystack.com`, `js.paystack.co`, `api.paystack.co`, `standard.paystack.co`), plus whichever bank 3-D Secure hosts real-card testing reveals. If the portal starts loading anything from a new external host, add it there too.
- Storage can be missing in captive-portal browsers. Wrap every `localStorage` access (see `store` in `apps/portal/src/lib.ts`).
- The hotspot context (`mac`, `ip`, `link-login-only`, `link-orig`) is captured on first load and must survive the Paystack redirect.

## Status and open items

- Built: customer accounts (with email password reset), time passes and data bundles, the purchase → access → usage/expiry flow, the account page with usage meters, the admin dashboard (including customer password reset), the MikroTik driver (tested against a fake RouterOS), the RouterOS setup template and the WireGuard config.
- **Not yet verified on real hardware.** The MikroTik REST calls, `yourwifi-setup.rsc` and usage counting must be checked on an actual router (see the go-live checklist).
- Plan prices in `scripts/seed.ts` are placeholders.
- Open decisions: exact router and AP models, VPS host, and the brand name and domain (search for `YourWiFi` and `yourwifi.ng`).
- Possible next steps: RADIUS for multi-site, signing out other devices after a password reset (customer cookies are stateless JWTs, so they stay valid until they expire), Paystack refunds from the admin dashboard, multiple routers per deployment (`network_devices` is ready for it, but the driver config is currently single-router via env).
