# YourWiFi

Paid Wi-Fi hotspot system. Customers join the Wi-Fi, sign in with their phone number and a password, buy a time pass or a data bundle with Paystack, and get online automatically. Access ends when the time or the data runs out, and customers can check what's left on their account page.

```
 phone ──Wi-Fi──▶ MikroTik hotspot ──(not paid: redirect)──▶ Portal (React)
                      ▲                                         │ choose plan, phone
                      │ REST API over WireGuard                 ▼
                      └──────────── API (Node/Express) ◀──── Paystack checkout
                                     │   ▲                       │
                                     ▼   └── webhook + verify ───┘
                                  Postgres
```

| Part | Path | What it does |
| --- | --- | --- |
| API | `apps/api` | Orders, Paystack, sessions, router control, admin API, background jobs |
| Portal | `apps/portal` | Captive portal: sign in → plans (bundles / time passes) → pay → connect; My account shows data and time left |
| Admin | `apps/admin` | Revenue, payments, sessions with data used, customers (password reset), plans, router health |
| Shared | `packages/shared` | Types and formatting shared by all three |
| Infra | `infra/` | RouterOS setup script, hotspot redirect pages, WireGuard config, go-live checklist |

## Run it locally (no router, no Paystack account needed)

Requires Node 22+. No database to install: dev mode uses embedded PGlite.

```bash
npm install
npm run db:seed                                      # adds time passes + 10/30/60/100 GB bundles (placeholder prices)
npm run admin:create -- you@example.com 'a-long-password'
npm run dev                                          # API :4000, portal :5173, admin :5174
```

- Portal: http://localhost:5173. Create an account, pick a plan, and use the simulated checkout to pass or fail the payment.
- Simulate data use on the mock router (watch My account update):
  `curl -X POST localhost:4000/api/dev/mock-usage/<ACCESS-CODE> -H 'content-type: application/json' -d '{"megabytes": 900}'`
- Admin: http://localhost:5174/admin/
- To simulate arriving from the hotspot, open
  `http://localhost:5173/?mac=AA:BB:CC:DD:EE:01&ip=10.5.50.20&link-login-only=http%3A%2F%2F10.5.50.1%2Flogin&link-orig=http%3A%2F%2Fexample.com`

Defaults are `PAYMENT_DRIVER=mock` and `NETWORK_DRIVER=mock`. Copy `apps/api/.env.example` to `apps/api/.env` to change them.

### Test with real Paystack (test mode)

1. Put your `sk_test_…` key in `apps/api/.env` and set `PAYMENT_DRIVER=paystack`.
2. Paystack must reach your webhook. Expose port 4000 (e.g. `cloudflared tunnel --url http://localhost:4000`), then set the webhook URL in the Paystack dashboard to `https://<tunnel>/api/webhooks/paystack`.
3. Even without the webhook, the status page's "Check my payment" and the reconcile job will confirm payments by calling Paystack's verify API.

## Tests

```bash
npm test          # API: payments, idempotency, expiry, router driver, admin, config guards
npm run typecheck
```

## Production

```bash
npm run build
cd apps/api && NODE_ENV=production SERVE_STATIC=true node dist/index.js
```

With `SERVE_STATIC=true`, a single process serves the portal at `/`, the admin dashboard at `/admin/` and the API at `/api`. This means the router's walled garden needs only one host for your app. Put it behind Caddy or Nginx for HTTPS and set `TRUST_PROXY=true`.

In production the API refuses to start unless it has real Postgres, a live Paystack key, the MikroTik driver and a JWT secret. See `infra/README.md` for the router, tunnel and go-live checklist.
