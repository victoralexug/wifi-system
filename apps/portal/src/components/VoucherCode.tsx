import { useState } from 'react';

/** The customer's voucher code, large and tap-to-copy. */
export function VoucherCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be blocked in in-app browsers; the code is still on screen.
    }
  };

  return (
    <div className="voucher" aria-label="Your voucher code">
      <span className="voucher-label">Your voucher code</span>
      <button type="button" className="voucher-code" onClick={copy} title="Tap to copy">
        {code}
      </button>
      <span className="voucher-hint">{copied ? 'Copied' : 'Tap to copy'}</span>
    </div>
  );
}
