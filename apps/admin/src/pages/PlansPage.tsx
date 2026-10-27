import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDataMb, formatDuration, formatNaira, type Plan } from '@yourwifi/shared';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api, type PlanInput } from '../api';
import { DataTable, Panel } from '../components/ui';

const UNITS = { minutes: 1, hours: 60, days: 1440 } as const;
type Unit = keyof typeof UNITS;

interface Draft {
  name: string;
  description: string;
  priceNaira: string;
  duration: string;
  unit: Unit;
  dataCapGb: string;
  active: boolean;
  sortOrder: string;
  voucherStockTarget: string;
}

const empty: Draft = { name: '', description: '', priceNaira: '', duration: '1', unit: 'hours', dataCapGb: '', active: true, sortOrder: '0', voucherStockTarget: '0' };

function toDraft(p: Plan): Draft {
  const unit: Unit = p.durationMinutes % 1440 === 0 ? 'days' : p.durationMinutes % 60 === 0 ? 'hours' : 'minutes';
  return {
    name: p.name,
    description: p.description,
    priceNaira: String(p.priceKobo / 100),
    duration: String(p.durationMinutes / UNITS[unit]),
    unit,
    dataCapGb: p.dataCapMb ? String(+(p.dataCapMb / 1024).toFixed(3)) : '',
    active: p.active,
    sortOrder: String(p.sortOrder),
    voucherStockTarget: String(p.voucherStockTarget),
  };
}

function fromDraft(d: Draft): PlanInput {
  return {
    name: d.name,
    description: d.description,
    // Convert to integer kobo exactly once, here.
    priceKobo: Math.round(Number(d.priceNaira) * 100),
    durationMinutes: Math.round(Number(d.duration) * UNITS[d.unit]),
    // Entered in GB, stored in MB (binary: 1 GB = 1024 MB).
    dataCapMb: d.dataCapGb ? Math.round(Number(d.dataCapGb) * 1024) : null,
    active: d.active,
    sortOrder: Number(d.sortOrder) || 0,
    voucherStockTarget: Math.max(0, Math.round(Number(d.voucherStockTarget) || 0)),
  };
}

export function PlansPage() {
  const qc = useQueryClient();
  const plans = useQuery({ queryKey: ['plans'], queryFn: api.plans });
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [draft, setDraft] = useState<Draft>(empty);

  const save = useMutation({
    mutationFn: (d: Draft) => (editing === 'new' ? api.createPlan(fromDraft(d)) : api.updatePlan(editing!, fromDraft(d))),
    onSuccess: () => {
      setEditing(null);
      void qc.invalidateQueries({ queryKey: ['plans'] });
    },
  });

  const start = (p: Plan | null) => {
    save.reset();
    setDraft(p ? toDraft(p) : empty);
    setEditing(p ? p.id : 'new');
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(draft);
  };

  const field = <K extends keyof Draft>(k: K) => ({
    value: draft[k] as string,
    onChange: (e: { target: { value: string } }) => setDraft({ ...draft, [k]: e.target.value }),
  });

  return (
    <div className="stack">
      <div className="row-between">
        <h1>Plans</h1>
        <button className="btn primary" onClick={() => start(null)}>
          New plan
        </button>
      </div>
      <p className="muted">
        Price changes apply to new purchases only. Past payments keep the price they were paid at.
        Plans can't be deleted because past payments refer to them; switch a plan off to hide it.
      </p>

      {editing && (
        <Panel title={editing === 'new' ? 'New plan' : 'Edit plan'}>
          <form className="form-grid" onSubmit={submit}>
            <label>
              Name
              <input required maxLength={60} {...field('name')} />
            </label>
            <label>
              Description
              <input maxLength={200} {...field('description')} placeholder="Shown under the name" />
            </label>
            <label>
              Price (₦)
              <input required type="number" min="1" step="0.01" inputMode="decimal" {...field('priceNaira')} />
            </label>
            <label>
              Duration
              <span className="inline">
                <input required type="number" min="1" step="1" {...field('duration')} />
                <select value={draft.unit} onChange={(e) => setDraft({ ...draft, unit: e.target.value as Unit })}>
                  {Object.keys(UNITS).map((u) => (
                    <option key={u}>{u}</option>
                  ))}
                </select>
              </span>
            </label>
            <label>
              Data bundle (GB)
              <input type="number" min="0.1" step="0.1" {...field('dataCapGb')} placeholder="Empty means unlimited data" />
            </label>
            <label>
              Sort order
              <input type="number" {...field('sortOrder')} />
            </label>
            <label>
              Sell at most this many per month
              <input type="number" min="0" step="1" {...field('voucherStockTarget')} />
              <small className="muted">
                On the monthly voucher day, codes are generated so this many are on sale, and no more sell until next month.
                0 = you upload codes yourself.
              </small>
            </label>
            <label className="check">
              <input type="checkbox" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} />
              Show to customers
            </label>
            {save.error && <p className="error span">{save.error.message}</p>}
            <div className="span row-end">
              <button type="button" className="btn ghost" onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button className="btn primary" disabled={save.isPending}>
                {save.isPending ? 'Saving…' : 'Save plan'}
              </button>
            </div>
          </form>
        </Panel>
      )}

      {plans.error && <p className="error">{plans.error.message}</p>}
      <DataTable>
        <thead>
          <tr>
            <th>Name</th>
            <th className="num">Price</th>
            <th>Duration</th>
            <th>Data</th>
            <th className="num">Codes left</th>
            <th>Visible</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {plans.data?.map((p) => (
            <tr key={p.id} className={p.active ? '' : 'dim'}>
              <td>
                <strong>{p.name}</strong>
                {p.description && <div className="muted small">{p.description}</div>}
              </td>
              <td className="num">{formatNaira(p.priceKobo)}</td>
              <td>{formatDuration(p.durationMinutes)}</td>
              <td>{p.dataCapMb ? formatDataMb(p.dataCapMb) : 'Unlimited'}</td>
              <td className="num">
                <Link to={`/vouchers?plan=${p.id}`}>{p.vouchersAvailable}</Link>
              </td>
              <td>{p.active ? 'Yes' : 'Hidden'}</td>
              <td className="actions">
                <button className="btn" onClick={() => start(p)}>
                  Edit
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </DataTable>
    </div>
  );
}
