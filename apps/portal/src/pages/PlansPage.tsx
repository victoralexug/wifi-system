import { formatDataMb, formatDuration, formatNaira, type PublicPlan } from '@yourwifi/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '../auth';
import { api, ApiError, navigate, signInUrl, store } from '../lib';

type Group = 'bundles' | 'passes';

export function PlansPage() {
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
        const chosen = p.find((x) => x.id === planId && !x.soldOut);
        const hasBundles = p.some((x) => x.dataCapMb !== null);
        const g: Group = chosen ? (chosen.dataCapMb !== null ? 'bundles' : 'passes') : hasBundles ? 'bundles' : 'passes';
        setGroup(g);
        if (!chosen) setPlanId(p.find((x) => (g === 'bundles') === (x.dataCapMb !== null) && !x.soldOut)?.id ?? null);
      })
      .catch((e: Error) => setLoadError(e.message));
  };
  useEffect(load, []);

  const bundles = plans?.filter((p) => p.dataCapMb !== null) ?? [];
  const passes = plans?.filter((p) => p.dataCapMb === null) ?? [];
  const shown = group === 'bundles' ? bundles : passes;
  const selected = plans?.find((p) => p.id === planId && !p.soldOut);
  const best = bestValue(shown);

  const switchGroup = (g: Group) => {
    setGroup(g);
    const list = g === 'bundles' ? bundles : passes;
    if (!list.some((p) => p.id === planId)) setPlanId(list.find((p) => !p.soldOut)?.id ?? null);
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
      const { authorizationUrl, reference } = await api.createOrder({ planId: selected.id });
      store.set('yw:reference', reference);
      location.assign(authorizationUrl);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        navigate(signInUrl(`/?plan=${selected.id}`));
        return;
      }
      // Sold out while the page was open: show it as sold out.
      if (err instanceof ApiError && err.code === 'sold_out') load();
      setError(err instanceof ApiError ? err.message : 'Could not start payment.');
      setSubmitting(false);
    }
  };

  return (
    <>
      <section className="hero">
        <h1>Fast internet, right where you are.</h1>
        <p>Choose your preferred data bundle and pay.</p>
      </section>

      {customer && (
        <a className="resume" href="/account">
          <span>Signed in as {customer.name ?? customer.phone}</span>
          <strong>My plans →</strong>
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

        <fieldset className="plans" disabled={submitting} aria-label={group === 'bundles' ? 'Data bundles' : 'Unlimited time'}>
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
          <div className="plan-grid">
            {shown.map((p) => {
              const [amount, unit] = (p.dataCapMb !== null ? formatDataMb(p.dataCapMb) : formatDuration(p.durationMinutes)).split(' ');
              return (
                <label key={p.id} className={`tile ${p.id === planId ? 'selected' : ''} ${p.soldOut ? 'sold-out' : ''}`}>
                  <input type="radio" name="plan" value={p.id} checked={p.id === planId} disabled={p.soldOut} onChange={() => setPlanId(p.id)} />
                  {p.id === best && <span className="tile-tag">Best value</span>}
                  <span className="tile-amount">
                    {amount}
                    <span>{unit}</span>
                  </span>
                  <span className="tile-desc">{p.dataCapMb !== null ? formatDuration(p.durationMinutes) : 'Unlimited data'}</span>
                  <span className="tile-price">{p.soldOut ? <span className="badge">Sold out</span> : formatNaira(p.priceKobo)}</span>
                </label>
              );
            })}
          </div>
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
            Sign in
          </a>
        )}
      </form>
    </>
  );
}

/** The cheapest per GB (or per day of unlimited), marked only when there's a real choice. */
function bestValue(plans: PublicPlan[]): string | undefined {
  const open = plans.filter((p) => !p.soldOut);
  if (open.length < 3) return undefined;
  const unitPrice = (p: PublicPlan) => p.priceKobo / (p.dataCapMb ?? p.durationMinutes);
  return open.reduce((a, b) => (unitPrice(b) < unitPrice(a) ? b : a)).id;
}
