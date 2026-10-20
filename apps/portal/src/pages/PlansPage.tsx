import { formatDataMb, formatDuration, formatNaira, type PublicPlan } from '@yourwifi/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '../auth';
import { api, ApiError, navigate, signInUrl, store, type HotspotContext } from '../lib';

type Group = 'bundles' | 'passes';

export function PlansPage({ hotspot }: { hotspot: HotspotContext }) {
  const { customer } = useAuth();
  const params = new URLSearchParams(location.search);
  const [plans, setPlans] = useState<PublicPlan[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [planId, setPlanId] = useState<string | null>(params.get('plan'));
  const [group, setGroup] = useState<Group>('bundles');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoadError(null);
    api
      .plans()
      .then((p) => {
        setPlans(p);
        const chosen = p.find((x) => x.id === planId);
        const hasBundles = p.some((x) => x.dataCapMb !== null);
        const g: Group = chosen ? (chosen.dataCapMb !== null ? 'bundles' : 'passes') : hasBundles ? 'bundles' : 'passes';
        setGroup(g);
        if (!chosen) setPlanId(p.find((x) => (g === 'bundles') === (x.dataCapMb !== null))?.id ?? null);
      })
      .catch((e: Error) => setLoadError(e.message));
  };
  useEffect(load, []);

  const bundles = plans?.filter((p) => p.dataCapMb !== null) ?? [];
  const passes = plans?.filter((p) => p.dataCapMb === null) ?? [];
  const shown = group === 'bundles' ? bundles : passes;
  const selected = plans?.find((p) => p.id === planId);

  const switchGroup = (g: Group) => {
    setGroup(g);
    const list = g === 'bundles' ? bundles : passes;
    if (!list.some((p) => p.id === planId)) setPlanId(list[0]?.id ?? null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    // Buying needs an account; come straight back to this plan after signing in.
    if (!customer) {
      navigate(signInUrl(`/?plan=${selected.id}`));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const { authorizationUrl, reference } = await api.createOrder({
        planId: selected.id,
        deviceMac: hotspot.mac,
        deviceIp: hotspot.ip,
      });
      store.set('yw:reference', reference);
      location.assign(authorizationUrl);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        navigate(signInUrl(`/?plan=${selected.id}`));
        return;
      }
      setError(err instanceof ApiError ? err.message : 'Could not start payment.');
      setSubmitting(false);
    }
  };

  return (
    <>
      <section className="hero">
        <h1>Fast internet, right where you are.</h1>
        <p>Choose a data bundle or a time pass, then pay with card, transfer or USSD.</p>
      </section>

      {hotspot.error && <div className="alert">{hotspot.error}</div>}

      {customer && (
        <a className="resume" href="/account">
          <span>Signed in as {customer.name ?? customer.phone}</span>
          <strong>Data &amp; time left →</strong>
        </a>
      )}

      <form onSubmit={submit} className="stack">
        {bundles.length > 0 && passes.length > 0 && (
          <div className="segmented" role="tablist" aria-label="Plan type">
            <button type="button" role="tab" aria-selected={group === 'bundles'} className={group === 'bundles' ? 'on' : ''} onClick={() => switchGroup('bundles')}>
              Data bundles
            </button>
            <button type="button" role="tab" aria-selected={group === 'passes'} className={group === 'passes' ? 'on' : ''} onClick={() => switchGroup('passes')}>
              Unlimited time
            </button>
          </div>
        )}

        <fieldset className="plans" disabled={submitting}>
          <legend>{group === 'bundles' ? 'Ends when data or time runs out' : 'Unlimited data until time runs out'}</legend>
          {loadError && (
            <div className="alert">
              {loadError}{' '}
              <button type="button" className="link" onClick={load}>
                Retry
              </button>
            </div>
          )}
          {!plans && !loadError && <div className="skeleton" aria-label="Loading plans" />}
          {plans?.length === 0 && <p className="muted">No plans are available right now.</p>}
          {shown.map((p) => (
            <label key={p.id} className={`plan ${p.id === planId ? 'selected' : ''}`}>
              <input type="radio" name="plan" value={p.id} checked={p.id === planId} onChange={() => setPlanId(p.id)} />
              <span className="plan-main">
                <span className="plan-name">{p.dataCapMb !== null ? formatDataMb(p.dataCapMb) : formatDuration(p.durationMinutes)}</span>
                <span className="plan-desc">
                  {p.dataCapMb !== null ? `Valid ${formatDuration(p.durationMinutes)}` : 'Unlimited data'}
                  {p.rateLimit && ` · up to ${p.rateLimit.split('/')[0]}bps`}
                </span>
              </span>
              <span className="plan-price">{formatNaira(p.priceKobo)}</span>
            </label>
          ))}
        </fieldset>

        {error && <div className="alert">{error}</div>}

        {/* Only the primary action stays pinned, so the plan list has room to breathe. */}
        <div className="sticky-cta">
          <button className="btn primary block" type="submit" disabled={!selected || submitting || customer === undefined}>
            {submitting
              ? 'Opening secure payment…'
              : !selected
                ? 'Choose a plan'
                : customer
                  ? `Pay ${formatNaira(selected.priceKobo)}`
                  : `Continue · ${formatNaira(selected.priceKobo)}`}
          </button>
        </div>
        {customer === null && (
          <a className="btn block" href={signInUrl('/account')}>
            Sign in to check data left
          </a>
        )}
      </form>
    </>
  );
}
