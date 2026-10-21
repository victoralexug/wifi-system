# Router, hosting and go-live

## Getting generated codes onto the router

Set a **stock target** on each plan (Plans page). On `VOUCHER_GENERATION_DAY` (default: the 1st) the API generates codes to top each plan up to its target. The batch shows on the Vouchers page as **Waiting for router**, and its codes aren't sold until they're on the router. Load it one of two ways:

- **Automatically (MikroTik):** set `ROUTER_TOKEN` (32+ random characters) on the API. In `mikrotik/yourwifi-voucher-sync.rsc` replace `API_HOST` (the Render host) and `ROUTER_TOKEN`, upload it to the router and run `/import yourwifi-voucher-sync.rsc`. Every 6 hours the router downloads any waiting batches, imports them as hotspot users and confirms, and the codes go on sale. It only makes outgoing requests, so it works behind Starlink. **Not yet tested on a real router**: try it on a virtual MikroTik (CHR) first.
- **By hand (any controller):** on the Vouchers page, download the batch as a **MikroTik file** (import with `/import file-name=…`) or **CSV**, load it on your controller, then click **Mark as loaded**.

Each code becomes a hotspot user whose name and password are the code, with the plan's `limit-uptime` and `limit-bytes-total`, in a profile per plan (`yw-<plan id>`, one device at a time). Note that `limit-uptime` counts time connected, not calendar days. If a 30-day plan should end 30 days after first login whatever the usage, set that up on the router (for example with a login script) before going live.

The hotspot itself (server, login page, walled garden for the portal and Paystack) is set up on the router separately.

## Hosting without a VPS

Three free services:

| Part | Where | Config |
| --- | --- | --- |
| Portal (`/`) and admin (`/admin/`) | **Netlify**, at `https://wifisystem.netlify.app` for now | `netlify.toml` |
| API | **Render** free web service | `render.yaml` |
| Database | **Supabase** free Postgres | `DATABASE_URL` on Render |

Netlify forwards `/api/*` to Render, so customers' browsers only ever talk to `wifisystem.netlify.app` and sign-in cookies are first-party. Point the Paystack webhook straight at Render: `https://<render host>/api/webhooks/paystack`.

**Order of setup:** Supabase first (to get `DATABASE_URL`), then Render (to get its host), then put that host into `netlify.toml` in place of `YOUR-API.onrender.com` and deploy Netlify. In Netlify's site settings the build command and publish folder come from `netlify.toml`, so leave them empty.

- **Supabase:** create a project and copy the **Session pooler** connection string (Render has no IPv6, and Supabase's direct connection is IPv6-only). Add `?sslmode=no-verify`, because Node doesn't trust Supabase's certificate authority by default, and set it as `DATABASE_URL`. Migrations run when the API starts.
- **Render:** create a Blueprint from the repo. Set `DATABASE_URL`, `ADMIN_JWT_SECRET` (32+ random characters) and `PAYSTACK_SECRET_KEY` (a `sk_test_` key while testing). `PUBLIC_PORTAL_URL` and `CORS_ORIGINS` are already set to the Netlify address in `render.yaml`.
- **Sleeping:** free Render services sleep after 15 minutes without traffic and take about a minute to wake on the next request. Paystack retries webhooks that time out, and the status page's "Check my payment" confirms payments directly, so nothing is lost, but the first visitor after a quiet spell waits. Render's cheapest paid instance removes this.
- **Testing mode:** `render.yaml` starts with `NODE_ENV=development` (so Paystack test keys are accepted) and `MAIL_DRIVER=mock` (password reset links appear in Render's logs instead of being emailed). At go-live switch to `NODE_ENV=production` and `MAIL_DRIVER=smtp`, and set a live Paystack key, `SMTP_URL` and `MAIL_FROM`. Production then refuses to start if anything is still in test mode.
- **Plans and admin login:** from your own computer, add them to the Supabase database (Render's free plan has no Shell). In PowerShell: `$env:DATABASE_URL="<the Supabase URI>"; npm run db:seed; npm run admin:create -- you@example.com 'a-long-password'`.
- **Your own domain later:** add it in Netlify, then change `PUBLIC_PORTAL_URL` and `CORS_ORIGINS` on Render.

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
