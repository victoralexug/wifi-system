# CLAUDE.md

This file guides Claude Code (claude.ai/code) when working in this repository.

## Project overview

**YourWiFi** (working name) sells Wi-Fi plans online as **voucher codes**. Admins load codes per plan (pasted or from a .txt/.csv file, typically exported from the Wi-Fi system's voucher generator). A customer creates an account (phone + password, with an email for password resets), picks a **time pass** or a **data bundle**, and pays with Paystack. On a confirmed payment they're given the next unused code for that plan, shown on the confirmation page and under My purchases; a declined payment shows a rejection. Admins see revenue, payments, customers, plans and voucher stock in a dashboard.

**Codes reach the router in batches, not over a live connection.** Each month (`VOUCHER_GENERATION_DAY`) the system generates codes to top each plan up to its stock target (`plans.voucher_stock_target`). A generated batch is "waiting for router" and **not sellable** until it's loaded: either the router collects it (`infra/mikrotik/yourwifi-voucher-sync.rsc` fetches `/api/router/vouchers.rsc` every 6 h with `ROUTER_TOKEN`, imports it, and the script's last line confirms the batch), or an admin downloads the MikroTik/CSV file and clicks "Mark as loaded". Codes an admin uploads came from the router, so they're sellable immediately. The live router integration (MikroTik REST drivers, check-in agent, device login, usage tracking) was removed on 2026-10-21 at the owner's request. A full copy is in the local git stash `backup before removing MikroTik` (`git stash list`). Don't reintroduce network code unless the owner asks.

See `README.md` for local setup and `infra/README.md` for hosting and the go-live checklist.

## Stack (decided)

| Layer | Choice |
| --- | --- |
| Monorepo | npm workspaces: `apps/api`, `apps/portal`, `apps/admin`, `packages/shared` |
| Backend | Node 22 + TypeScript, Express 5, Zod 4, Drizzle ORM, pino |
| Database | PostgreSQL in production. **PGlite** (embedded Postgres) when `DATABASE_URL` is unset, for dev and tests |
| Payments | **Paystack** (`PaystackProvider`), plus `MockPaymentProvider` for local dev |
| Email | SMTP through nodemailer (`SmtpMailService`), plus `MockMailService`, which logs reset links to the API console |
| Hosting | No VPS: **Netlify** serves the portal and admin and runs the API as **Netlify Functions** (`apps/api/src/functions`: `api` for `/api/*`, `jobs` scheduled every 5 min), `netlify.toml`, currently `https://wifisystem.netlify.app`; **Supabase** free Postgres (transaction pooler). Migrations run in the Netlify build. Being deployed (2026-10-27) |
| Customer accounts | Sign in with phone number (normalized to +234…) + password (scrypt). Email (lowercased, unique) is required at sign-up and used only for password reset: a single-use link valid for 30 minutes, token stored as a SHA-256 hash and carried in the URL fragment. Admins can also issue a one-time password (Customers page). No SMS. Signed-JWT httpOnly cookie `yw_customer` (SameSite=Lax, 30 days) |
| Portal | React 19 + Vite. No router or UI library, kept small for phones on weak connections |
| Admin | React 19 + Vite + React Router 7 + TanStack Query, served at `/admin/` |
| Tests | Vitest + Supertest against in-memory PGlite |

## Commands

```bash
npm install
npm run dev                    # api :4000 (tsx watch), portal :5173, admin :5174 (both proxy /api)
npm test                       # API test suite (~90 s; each test boots an in-memory PGlite)
npm run typecheck              # all workspaces
npm run build                  # portal, admin, then API (tsup → apps/api/dist)
npm run build:web              # portal + admin into apps/portal/dist (admin under /admin), for Netlify
npm run db:generate            # after editing apps/api/src/db/schema.ts: writes SQL to apps/api/drizzle/
npm run db:migrate | db:seed
npm run admin:create -- <email> <password>
```

Run one test file: `cd apps/api && npx vitest run test/flow.test.ts`. Migrations also run automatically when the API starts.

## Code map (apps/api/src)

- `config.ts`: Zod-validated env. **Production guards live here** (no mock payments or mail, Postgres required, no Paystack test keys).
- `orders/orders.service.ts`: `create` (refuses sold-out plans), **`confirmPayment`** (the only path to a paid order and its voucher), `getStatus`, `reconcilePending`.
- `vouchers/vouchers.service.ts`: `assign` (next sellable code for the order's plan, `FOR UPDATE SKIP LOCKED`), `assignWaiting` (paid orders that got no code because the plan ran out), `add` (bulk upload), `generate` / `generateScheduled` (monthly top-up batch, one per `period`), `markReady`, `stock`.
- `vouchers/export.ts`: a batch as a RouterOS import script (hotspot user per code; name = password = code; plan → profile `yw-<plan id>`, `limit-uptime`, `limit-bytes-total`) or CSV.
- `routes/router.routes.ts`: `/api/router/*` for the router's sync script (only when `ROUTER_TOKEN` is set).
- `customers/`: customer auth (`/api/auth/register|login|logout|forgot-password|reset-password`) and account API (`/api/me`, `/api/me/orders`, `/api/me/password`, `/api/me/email`).
- `mail/`: the `MailService` interface, SMTP, and mock.
- `lib/auth.ts`: shared signed-cookie sessions. Admin and customer tokens use different audiences and cookies, so neither is accepted as the other.
- `payments/`: the `PaymentProvider` interface, Paystack, and mock.
- `routes/`: public (`/api/plans`; `/api/orders*` need a signed-in customer and only return their own orders), webhook (`/api/webhooks/paystack`), dev (`/api/dev/mock-pay`, mock payments only).
- `admin/`: JWT cookie auth (`yw_admin`, SameSite=Strict) and the admin API (stats, orders, customers, plans, vouchers).
- `serverless.ts` + `functions/`: the Netlify Functions entry points. `functions/api.ts` wraps the Express app with serverless-http; `functions/jobs.ts` runs every job once (`runJobsOnce`). `index.ts` is the long-lived server for local dev.
- `lib/rate-limit-store.ts`: express-rate-limit counters in Postgres (`rate_limits`), because function instances share no memory. Every limiter uses it with its own key prefix.
- `jobs.ts`: the reconcile loop (`RECONCILE_INTERVAL_SECONDS`): Paystack pending orders, then waiting voucher assignments; and an hourly check for the monthly voucher batch (catches up if the server slept through the day).

## Non-negotiable rules

- **An order is marked paid only by `confirmPayment`.** It calls Paystack's verify API and checks the status, amount and currency against the order. Webhooks, the "check my payment" button and the reconcile job all route through it. Never trust the frontend, the callback URL or the webhook body alone.
- **Idempotency is enforced in the database.** The `pending|failed → success` update is conditional, so an order is confirmed exactly once, and the voucher is assigned in the same transaction. `vouchers.order_id` and `vouchers.code` are unique: an order gets one code, and a code goes to one order. Keep it that way when touching the order flow.
- **A code is sellable only when it's on the router** (`vouchers.ready_at` set) and unused. Never sell or show a generated code before its batch is marked ready. The monthly target counts unsold codes whether or not they're on the router yet, so an uncollected batch isn't duplicated.
- **A paid order without a code is "waiting", never lost.** If the plan sells out between checkout and payment, the order is still marked paid; `assignWaiting` gives it a code when an admin adds more (on upload, and in the reconcile job). Plans with no unused codes show as sold out and refuse new orders.
- **Voucher codes are only shown to their buyer** (customer endpoints filter by `customerId`) and to admins. Used codes can't be deleted.
- **Amount or currency mismatch → `flagged`**, never `success`.
- **Webhook signature:** HMAC-SHA512 of the *raw* body with the secret key, compared timing-safe against `x-paystack-signature`. The webhook router is mounted before `express.json()` and must stay there.
- **Money is integer kobo.** Admin and portal UIs convert to and from naira only at the edges.
- Plans are deactivated, never deleted, because orders reference them. Price edits apply to new orders only. Plan updates (`PATCH`) change only the fields sent: the update schema has no defaults.
- Data sizes are binary (1 GB = 1024 MB). Plans store `data_cap_mb` (null = unlimited data); the admin form takes GB.
- Customer login rate limits count **failed attempts only**, keyed per phone or customer, never per IP. Reset-email requests count every request, keyed per email.
- `/api/auth/forgot-password` always answers 204, whether or not the email has an account.
- **Secrets stay in `apps/api/.env`.** Keep `.env.example` in sync when adding config.
- Timestamps are stored in UTC and shown in Africa/Lagos time (UTC+1, no DST). In SQL, convert `timestamptz` with `at time zone 'UTC'` before shifting. Never rely on the DB session time zone.
- Customers may share one public IP (e.g. one Starlink dish), so keep per-IP rate limits generous.

## Design system

Based on `design guide/` (the "5 Rules of Clean Design" slides). Tokens live at the top of `apps/portal/src/styles.css` and `apps/admin/src/styles.css`. Use the tokens; never hard-code colours or sizes.

- **Colours (limit them):** primary indigo `#3f4482`, secondary lavender `#aeb3da`, neutral grey `#e4e4e4`, background `#f6f9fa`, text `#161b26`. In dark mode lavender becomes the primary. Red is for errors only. The admin dashboard may also use good/warning/critical status colours, always with an icon and a label.
- **Hierarchy:** one filled indigo pill (`.btn.primary`) per screen; every other action is a grey pill (`.btn`). In the portal, only the primary CTA is sticky.
- **Typography:** Inter, self-hosted through `@fontsource-variable/inter` (no Google Fonts). The portal loads only the Latin subset. There are four sizes, `--fs-display`, `--fs-title`, `--fs-body` and `--fs-small`, and weights 400, 500 and 600.
- **Whitespace:** the 8px scale `--s1`…`--s6`, centred headings with muted subtitles, and borderless surface cards with 20px radius (16px in admin). In the admin dashboard, cards, tiles, tables and inputs have a hairline `--border` and soft `--shadow` so they stand out (owner request, 2026-10-27).
- **Admin on phones:** wrap tables in `DataTable` (`components/ui.tsx`). Below 640px each row becomes a card with every value labelled by its column heading.
- **Chart bars:** `#4a50a0` in light mode and `#6e76d6` in dark. Both pass the dataviz palette validator; the brand `#3f4482` is too dark for marks.

## Portal constraints

- Storage can be missing in in-app and private browsers. Wrap every `localStorage` access (see `store` in `apps/portal/src/lib.ts`).
- The order reference is stored before redirecting to Paystack, so `/status` can find it even if Paystack's return URL loses it.

## Status and open items

- Built: customer accounts (with email password reset), plans (time passes and data bundles), voucher stock per plan with bulk upload, monthly generated batches delivered to the router (sync script or download), Paystack checkout with a confirmation page showing the voucher code or a rejection page, purchase history with codes on the account page, and the admin dashboard (revenue, payments, customers with password reset, plans, vouchers, low-stock alerts).
- The starter catalogue in `scripts/seed.ts` is the owner's real one (2026-10-21): 1 GB/1 day ₦150 ×200, 10 GB/1 week ₦3,000 ×60, 30 GB/2 weeks ₦5,000 ×20, 60 GB/30 days ₦7,000 ×20, 100 GB/30 days ₦10,000 ×20 per month (stock targets), 4,600 GB a month in total. Added 2026-10-27: Unlimited 1 week ₦5,000 ×20 and Unlimited 30 days ₦20,000 ×5 (not part of the 4,600 GB) against a 5 TB Starlink plan renewed on the 2nd (`VOUCHER_GENERATION_DAY=2` in Netlify's environment variables). **The stock target is also the monthly sales cap**: the monthly batch only tops up to it. Uploading extra codes or raising a target mid-month lets more be sold that month.
- **Verified on a virtual router (CHR 7.25 in Hyper-V, 2026-10-28):** `yourwifi-voucher-sync.rsc` installs, fetches the batch, imports it as hotspot users and confirms it, and a second run finds nothing new. Not yet tried on the real router, and customer login through the hotspot is untested. `limit-uptime` counts connected time, not calendar days; calendar expiry for multi-day plans needs a router-side setting or script.
- Open decisions: hosting (Netlify + Supabase) is being set up; the brand name and domain (search for `YourWiFi` and `yourwifi.ng`); an email provider for production.
- Possible next steps: signing out other devices after a password reset (customer cookies are stateless JWTs, so they stay valid until they expire), Paystack refunds from the admin dashboard.
