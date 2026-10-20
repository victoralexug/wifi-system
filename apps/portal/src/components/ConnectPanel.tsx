import type { SessionView } from '@yourwifi/shared';
import { useEffect, useState } from 'react';
import { safeLoginUrl, store, type HotspotContext } from '../lib';
import { UsageMeter } from './UsageMeter';

/**
 * Shows an active plan with its data and time left, and logs the device in by posting the
 * code to the router's hotspot login page (the hotspot must allow http-pap; see infra/mikrotik).
 */
export function ConnectPanel({ session, hotspot, now: nowProp }: { session: SessionView; hotspot: HotspotContext; now?: number }) {
  const loginUrl = safeLoginUrl(hotspot);
  const [tick, setTick] = useState(Date.now());
  const [copied, setCopied] = useState(false);
  const now = Math.max(nowProp ?? 0, tick);

  useEffect(() => {
    store.set('yw:code', session.voucherCode);
    const t = setInterval(() => setTick(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [session.voucherCode]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(session.voucherCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard is often blocked in captive-portal browsers; the code is still on screen.
    }
  };

  return (
    <section className="card">
      <div className="badge ok">Active</div>
      <h2>{session.planName}</h2>

      <UsageMeter session={session} now={now} />

      <div className="voucher" aria-label="Your access code">
        <span className="voucher-label">Access code</span>
        <button type="button" className="voucher-code" onClick={copy} title="Tap to copy">
          {session.voucherCode.replace(/(.{4})/, '$1 ')}
        </button>
        <span className="voucher-hint">{copied ? 'Copied' : 'Works on one device at a time'}</span>
      </div>

      {loginUrl ? (
        <form method="post" action={loginUrl}>
          <input type="hidden" name="username" value={session.voucherCode} />
          <input type="hidden" name="password" value={session.voucherCode} />
          <input type="hidden" name="dst" value={hotspot.linkOrig ?? ''} />
          <input type="hidden" name="popup" value="false" />
          <button className="btn primary block" type="submit">
            Connect this device
          </button>
        </form>
      ) : (
        <p className="note">
          To go online, join the Wi-Fi network and open any website. When this page appears, sign in and tap{' '}
          <strong>Connect this device</strong>.
        </p>
      )}
    </section>
  );
}
