# Infrastructure and go-live

## Hardware (recommended starting point)

Any MikroTik router running **RouterOS v7.1 or later** works, because the API uses the v7 REST API.

| Role | Suggested | Notes |
| --- | --- | --- |
| Router / hotspot controller | MikroTik hEX (RB750Gr3) or hEX S, or an RB5009 for 100+ users | Runs the hotspot, DHCP, NAT and WireGuard |
| Access points | MikroTik cAP ax / wAP ax (outdoor) | Bridge them to the router's LAN ports. They must not run their own DHCP/NAT |
| Uplink | Starlink in **Bypass mode** (or the Starlink Ethernet adapter) | Starlink uses CGNAT, which is why the router dials out over WireGuard |

## How the pieces connect

1. **Backend VPS** (any Linux VPS with a public IP) runs the API + Postgres behind Caddy/Nginx, and WireGuard (`wireguard/vps-wg0.conf.example`) on 10.8.0.1.
2. **Router** imports `mikrotik/yourwifi-setup.rsc` (fill in the placeholders first). It:
   - creates the hotspot on 10.5.50.0/24 with `login-by=http-pap,mac-cookie`
   - opens the walled garden to your portal host and Paystack
   - dials the WireGuard tunnel to the VPS (10.8.0.2)
   - exposes the REST API only over the tunnel, to a least-privilege `yourwifi-api` user
3. **Hotspot pages:** replace `PORTAL_HOST` in `mikrotik/hotspot/*.html` and upload them to the router's `yourwifi` folder. `login.html` redirects every unpaid device to the portal and passes `mac`, `ip`, `link-login-only` and `link-orig`.
4. **API `.env`:** `NETWORK_DRIVER=mikrotik`, `MIKROTIK_URL=https://10.8.0.2`, `MIKROTIK_USER=yourwifi-api`, the password, `MIKROTIK_INSECURE_TLS=true` (the self-signed cert stays inside the tunnel), and `MIKROTIK_HOTSPOT_SERVER=hotspot1`.
5. **Portal build env:** `VITE_HOTSPOT_LOGIN_HOSTS=10.5.50.1,login.yourwifi`. The portal only posts voucher codes to these hosts.

## How access works

- After a verified payment, the API creates a hotspot user on the router. Its name and password are both the 8-character voucher code. Its profile `yw-<rate>` carries the speed limit and `shared-users=1`, so only one device can use it at a time.
- The portal then posts the code to the router's login page, which logs the phone in. A MAC cookie lets it reconnect automatically.
- **Expiry is wall-clock.** The API's job removes the user, kicks the active session and deletes the cookies at `expires_at`. The `limit-uptime` set on the router is only a backstop in case the backend is unreachable.
- **Data bundles:** the user also gets `limit-bytes-total`. RouterOS only updates a user's byte totals at logout, so the API polls usage every 30 s (user totals + live `/ip/hotspot/active` counters) and disconnects the customer as soon as the bundle is used up. Customers see the same numbers on their account page.
- If the router is unreachable at payment time, the session stays `pending` and is retried every 30 s. The admin dashboard shows it, with a "Retry now" button.

## Go-live checklist

**Business and legal**
- [ ] Your Starlink plan and terms allow reselling access (a Business/Priority plan is likely required)
- [ ] NCC licensing for commercial internet service (check the current class licence requirements)
- [ ] Paystack business verification is complete and live keys are issued

**Backend**
- [ ] `NODE_ENV=production`, real `DATABASE_URL`, `ADMIN_JWT_SECRET` (32+ random chars), `sk_live_` key
- [ ] HTTPS on the portal domain; `TRUST_PROXY=true` behind the proxy
- [ ] Paystack dashboard webhook URL set to `https://<host>/api/webhooks/paystack`
- [ ] Postgres backups scheduled
- [ ] Admin account created with a strong password (`npm run admin:create`)
- [ ] `MAIL_DRIVER=smtp` with a real `SMTP_URL` and `MAIL_FROM`; SPF and DKIM set up for the sending domain
- [ ] "Forgot your password?" email arrives (check the spam folder too) and its link opens the portal

**Router**
- [ ] `mikrotik/yourwifi-setup.rsc` reviewed by the technician and imported; hotspot pages uploaded
- [ ] WireGuard is up: the API's Network page shows the router **Online** with its identity
- [ ] From the VPS: `curl -k -u yourwifi-api:… https://10.8.0.2/rest/system/identity` works
- [ ] RouterOS admin password changed; Winbox/SSH not reachable from WAN

**End-to-end on the real network** (use a temporary 2-minute, ₦100 plan)
- [ ] A new phone is redirected to the portal automatically
- [ ] Paystack checkout loads inside the walled garden: card, transfer and USSD
- [ ] Bank 3-D Secure pages load. Add any blocked hosts to the walled garden
- [ ] After paying, "Connect to the internet" logs the phone in
- [ ] The same code can't be used on a second phone at the same time
- [ ] After 2 minutes the phone is disconnected and sent back to the portal
- [ ] Create a temporary 50 MB bundle: stream a video, check that the account page usage climbs within about 30 s, and that the phone is cut off at about 50 MB
- [ ] Compare a session's "Data used" in admin with `/ip hotspot active print stats` on the router. They should match within one poll interval
- [ ] Unplug the WireGuard tunnel, pay, then reconnect it: access turns on automatically within about 30 s
- [ ] Hide the test plan
