# YourWiFi

Sells Wi-Fi plans online as voucher codes. Codes come from two places: admins upload them (pasted, or a .txt/.csv export from the Wi-Fi system), or the system generates a batch each month to top every plan up to a stock target and the router collects it. Customers create an account with their phone number and a password (and can reset a forgotten password by email), choose a time pass or a data bundle, and pay with Paystack. A confirmed payment shows them their voucher code; a declined one shows a rejection. Their codes stay under My purchases. Admins track revenue, payments, customers, plans and voucher stock in a dashboard.

The router isn't connected live. Generated batches reach it either through a small script on the router that collects them every few hours (`infra/mikrotik/yourwifi-voucher-sync.rsc`), or by downloading the batch from the admin dashboard and importing it. Generated codes only go on sale once they're on the router. Customers type their code into the Wi-Fi login page.

```
 Portal (React) ──choose plan──▶ API (Node/Express) ──▶ Paystack checkout
       ▲                            │   ▲                     │
       └─ confirmation / rejection ─┘   └─ webhook + verify ──┘
                                    │
                                 Postgres ◀── Admin dashboard (React)
```

| Part | Path | What it does |
| --- | --- | --- |
| API | `apps/api` | Accounts, orders, Paystack, admin API, payment reconcile job |
| Portal | `apps/portal` | Sign up / sign in → plans (bundles / time passes) → pay → voucher code or rejection; My account lists purchases with their codes |
| Admin | `apps/admin` | Revenue, payments, customers (password reset), plans (with stock targets), vouchers (stock, upload, generated batches, low-stock alerts) |
| Shared | `packages/shared` | Types and formatting shared by all three |
| Infra | `infra/`, `netlify.toml`, `render.yaml` | Router voucher sync script, hosting setup and go-live checklist |

## Run it locally (no Paystack account needed)

Requires Node 22+. No database to install: dev mode uses embedded PGlite.

```bash
npm install
npm run db:seed                                      # adds time passes + 10/30/60/100 GB bundles (placeholder prices)
npm run admin:create -- you@example.com 'a-long-password'
npm run dev                                          # API :4000, portal :5173, admin :5174
```

- Admin: http://localhost:5174/admin/. Open **Vouchers** and add a few codes for a plan first (any text without spaces works, e.g. `TEST-001 TEST-002`). Plans without codes show as sold out.
- Portal: http://localhost:5173. Create an account, pick a plan, and use the simulated checkout to pass or fail the payment. A successful payment shows one of your codes.
- Password reset: emails aren't sent in dev (`MAIL_DRIVER=mock`). The reset link is printed in the API console.

The default is `PAYMENT_DRIVER=mock`. Copy `apps/api/.env.example` to `apps/api/.env` to change it.

### Test with real Paystack (test mode)

1. Put your `sk_test_…` key in `apps/api/.env` and set `PAYMENT_DRIVER=paystack`.
2. Paystack must reach your webhook. Expose port 4000 (e.g. `cloudflared tunnel --url http://localhost:4000`), then set the webhook URL in the Paystack dashboard to `https://<tunnel>/api/webhooks/paystack`.
3. Even without the webhook, the status page's "Check my payment" and the reconcile job confirm payments by calling Paystack's verify API.
4. Pay with one of Paystack's test cards (see "Test payments" in Paystack's docs).

## Tests

```bash
npm test          # API: accounts, payments, vouchers, idempotency, webhooks, admin, config guards
npm run typecheck
```

## Production

Planned hosting is Netlify (portal + admin) + Render (API) + Supabase (database). See `infra/README.md` for setup and the go-live checklist.

To run everything from one server instead:

```bash
npm run build
cd apps/api && NODE_ENV=production SERVE_STATIC=true node dist/index.js
```

With `SERVE_STATIC=true`, a single process serves the portal at `/`, the admin dashboard at `/admin/` and the API at `/api`. Put it behind Caddy or Nginx for HTTPS and set `TRUST_PROXY=true`.

In production the API refuses to start unless it has real Postgres, a live Paystack key, real email and a JWT secret.
