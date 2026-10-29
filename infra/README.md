# Router, hosting and go-live

## Getting generated codes onto the router

Set a **stock target** on each plan (Plans page). On `VOUCHER_GENERATION_DAY` (default: the 1st) the API generates codes to top each plan up to its target. The batch shows on the Vouchers page as **Waiting for router**, and its codes aren't sold until they're on the router. Load it one of two ways:

- **Automatically (MikroTik):** set `ROUTER_TOKEN` (32+ random characters) on the API. In `mikrotik/yourwifi-voucher-sync.rsc` replace `API_HOST` (the Netlify host) and `ROUTER_TOKEN`, upload it to the router and run `/import yourwifi-voucher-sync.rsc`. Every 6 hours the router downloads any waiting batches, imports them as hotspot users and confirms, and the codes go on sale. Every 15 minutes it reports each code's used time and data, which customers see on their account page. It only makes outgoing requests, so it works behind Starlink. **Not yet tested on a real router**: try it on a virtual MikroTik (CHR) first.
- **By hand (any controller):** on the Vouchers page, download the batch as a **MikroTik file** (import with `/import file-name=…`) or **CSV**, load it on your controller, then click **Mark as loaded**.

Each code becomes a hotspot user whose name and password are the code, with the plan's `limit-uptime` and `limit-bytes-total`, in a profile per plan (`yw-<plan id>`, one device at a time). A code lasts its plan's duration from purchase, used or not: every 15 minutes the sync script fetches the expired codes and removes them from the router. `limit-uptime` (connected time) is only a backstop, for when the router can't reach the API.

The hotspot itself (server, login page, walled garden for the portal and Paystack) is set up on the router separately.

## Hosting

Two free services:

| Part | Where | Config |
| --- | --- | --- |
| Portal (`/`), admin (`/admin/`) and API (`/api/`) | **Netlify**, at `https://wifisystem.netlify.app` for now | `netlify.toml` |
| Database | **Supabase** free Postgres | `DATABASE_URL` in Netlify |

The API runs as two Netlify Functions in `apps/api/src/functions`: `api` serves every `/api/*` request, and `jobs` runs every 5 minutes to re-check unconfirmed payments with Paystack, give waiting orders their codes, and make the monthly voucher batch. Migrations run in each Netlify build, before the new version goes live. Everything is on one host, so sign-in cookies are first-party and the hotspot's walled garden needs only that host.

- **Supabase:** in the project, click **Connect**, open the **Direct** tab (connection string) and pick **Transaction pooler** (port 6543). Replace `[YOUR-PASSWORD]` with the database password (Project Settings → Database can reset it) and add `?sslmode=no-verify` at the end, because Node doesn't trust Supabase's certificate authority by default.
- **Netlify:** in Site configuration → Environment variables, set:

  | Variable | Value |
  | --- | --- |
  | `DATABASE_URL` | the Supabase string above |
  | `ADMIN_JWT_SECRET`, `ROUTER_TOKEN` | 32+ random characters each |
  | `PAYSTACK_SECRET_KEY` | `sk_test_…` while testing |
  | `PAYMENT_DRIVER` | `paystack` |
  | `PUBLIC_PORTAL_URL`, `CORS_ORIGINS` | `https://wifisystem.netlify.app` |
  | `TRUST_PROXY` | `true` |
  | `VOUCHER_GENERATION_DAY` | `2` (the Starlink renewal day) |
  | `MAIL_DRIVER` | `mock` while testing |

  Then trigger a deploy. In Netlify's build settings the build command, publish folder and functions folder come from `netlify.toml`, so leave them empty.
- **Paystack:** set the webhook URL to `https://wifisystem.netlify.app/api/webhooks/paystack`.
- **Testing mode:** with `MAIL_DRIVER=mock`, password reset links appear in the `api` function's logs (Netlify → Logs → Functions) instead of being emailed. At go-live set `NODE_ENV=production` **with its scope limited to Functions** (in Builds it would stop npm installing the build tools), `MAIL_DRIVER=smtp`, a live Paystack key, `SMTP_URL` and `MAIL_FROM`. The API then refuses to start if anything is still in test mode.
- **Plans and admin login:** from your own computer, add them to the Supabase database. In PowerShell: `$env:DATABASE_URL="<the Supabase URI>"; npm run db:seed; npm run admin:create -- you@example.com 'a-long-password'`.
- **Your own domain later:** add it in Netlify, then change `PUBLIC_PORTAL_URL`, `CORS_ORIGINS` and the Paystack webhook URL.
- **Limits:** each API request must finish within Netlify's function timeout (10 s by default), and the free plan has monthly usage limits; a voucher shop stays far below both. Rate-limit counters live in the `rate_limits` table, because function instances share no memory.

## Go-live checklist

**Business**
- [ ] Paystack business verification is complete and live keys are issued
- [ ] Stock targets set per plan, and the first generated batch is **On router** (or codes uploaded)
- [ ] Real plan prices set in the admin dashboard (the seeded prices are placeholders)
- [ ] Each plan's voucher codes in the admin dashboard match the plan's time and data limits in the Wi-Fi system that accepts them
- [ ] Enough codes loaded for every active plan (the Overview warns when a plan has fewer than 10 left)

**Backend**
- [ ] `NODE_ENV=production`, real `DATABASE_URL`, `ADMIN_JWT_SECRET` (32+ random chars), `sk_live_` key
- [ ] HTTPS on the portal domain; `TRUST_PROXY=true` behind the proxy
- [ ] Paystack dashboard webhook URL set to `https://<api host>/api/webhooks/paystack`
- [ ] Postgres backups scheduled
- [ ] Admin account created with a strong password (`npm run admin:create`)
- [ ] `MAIL_DRIVER=smtp` with a real `SMTP_URL` and `MAIL_FROM`; SPF and DKIM set up for the sending domain
- [ ] "Forgot your password?" email arrives (check the spam folder too) and its link opens the portal

**End-to-end** (use a temporary ₦100 plan)
- [ ] Sign up, buy the plan with a real card, transfer and USSD: each shows "Payment successful" with a voucher code, and the code is under My purchases
- [ ] The code logs a device in on the Wi-Fi, with the plan's time and data limits
- [ ] A declined card shows "Payment declined", and the order shows as Failed in the admin dashboard
- [ ] Close the browser during payment, then reopen My purchases: the payment still shows as paid (webhook or reconcile job)
- [ ] Revenue for the test payment appears on the admin Overview
- [ ] Hide the test plan
