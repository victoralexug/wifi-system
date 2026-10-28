import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AddVouchersResult } from '@yourwifi/shared';
import { useState, type ChangeEvent, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { api, fmtTime } from '../api';
import { DataTable, Filters, Pager, Panel, StatusBadge, useDebounced } from '../components/ui';

export function VouchersPage() {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const page = Number(params.get('page') ?? 1);
  const status = params.get('status') ?? '';
  const planId = params.get('plan') ?? '';
  const [q, setQ] = useState('');
  const dq = useDebounced(q);

  const stock = useQuery({ queryKey: ['voucher-stock'], queryFn: api.voucherStock });
  const list = useQuery({
    queryKey: ['vouchers', page, status, planId, dq],
    queryFn: () => api.vouchers({ page, status: status || undefined, q: dq || undefined, planId: planId || undefined }),
    placeholderData: keepPreviousData,
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['voucher-stock'] });
    void qc.invalidateQueries({ queryKey: ['vouchers'] });
    void qc.invalidateQueries({ queryKey: ['voucher-batches'] });
    void qc.invalidateQueries({ queryKey: ['stats'] });
  };

  const remove = useMutation({ mutationFn: api.deleteVoucher, onSuccess: refresh });
  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    next.set('page', '1');
    setParams(next);
  };

  return (
    <div className="stack">
      <h1>Vouchers</h1>

      <Panel title="Stock">
        {stock.error && <p className="error">{stock.error.message}</p>}
        <DataTable>
          <thead>
            <tr>
              <th>Plan</th>
              <th className="num">On sale</th>
              <th className="num">Waiting for router</th>
              <th className="num">Monthly limit</th>
              <th className="num">Given out</th>
              <th className="num">Orders waiting</th>
            </tr>
          </thead>
          <tbody>
            {stock.data?.map((s) => (
              <tr key={s.planId}>
                <td>
                  {s.planName}
                  {!s.active && <span className="muted small"> (hidden)</span>}
                </td>
                <td className="num">{s.available > 0 || !s.active || s.waitingForRouter > 0 ? s.available : <StatusBadge status="sold_out" />}</td>
                <td className="num">{s.waitingForRouter || '—'}</td>
                <td className="num">{s.target || '—'}</td>
                <td className="num">{s.used}</td>
                <td className="num">{s.waitingOrders > 0 ? <StatusBadge status="waiting" /> : null} {s.waitingOrders || '—'}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      </Panel>

      <Batches onChanged={refresh} />

      <AddVouchers plans={stock.data ?? []} onAdded={refresh} />

      <Panel title="Codes">
        <Filters
          statuses={['available', 'used']}
          status={status}
          onStatus={(s) => setParam('status', s)}
          q={q}
          onQ={(v) => {
            setQ(v);
            if (page !== 1) setParam('page', '1');
          }}
          placeholder="Search code or payment reference"
        />
        <select className="plan-filter" value={planId} onChange={(e) => setParam('plan', e.target.value)} aria-label="Filter by plan">
          <option value="">All plans</option>
          {stock.data?.map((s) => (
            <option key={s.planId} value={s.planId}>
              {s.planName}
            </option>
          ))}
        </select>
        {(list.error || remove.error) && <p className="error">{list.error?.message ?? remove.error?.message}</p>}
        <DataTable>
          <thead>
            <tr>
              <th>Code</th>
              <th>Plan</th>
              <th>Status</th>
              <th>Given to</th>
              <th>Added</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.data?.items.map((v) => (
              <tr key={v.id}>
                <td className="mono">{v.code}</td>
                <td>{v.planName}</td>
                <td>
                  <StatusBadge status={v.status} />
                </td>
                <td>
                  {v.phone ?? '—'}
                  {v.orderReference && (
                    <div className="muted small">
                      {v.orderReference} · {fmtTime(v.assignedAt)}
                    </div>
                  )}
                </td>
                <td>{fmtTime(v.createdAt)}</td>
                <td className="actions">
                  {v.status === 'available' && (
                    <button className="btn" disabled={remove.isPending} onClick={() => remove.mutate(v.id)}>
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
        {list.data && (
          <Pager page={page} pageSize={list.data.pageSize} total={list.data.total} onPage={(p) => setParam('page', String(p))} />
        )}
      </Panel>
    </div>
  );
}

/** Generated batches: download them for the router, or see that the router collected them. */
function Batches({ onChanged }: { onChanged: () => void }) {
  const batches = useQuery({ queryKey: ['voucher-batches'], queryFn: api.voucherBatches });
  const [note, setNote] = useState<string | null>(null);
  const generate = useMutation({
    mutationFn: api.generateBatch,
    onSuccess: (r) => {
      setNote(
        r.batch
          ? `Generated ${r.batch.codeCount} codes.`
          : 'Nothing to generate: every plan is at its monthly limit.',
      );
      onChanged();
    },
  });
  const ready = useMutation({ mutationFn: api.markBatchReady, onSuccess: onChanged });

  return (
    <Panel
      title="Generated batches"
      actions={
        <button className="btn" onClick={() => generate.mutate()} disabled={generate.isPending}>
          {generate.isPending ? 'Generating…' : 'Generate now'}
        </button>
      }
    >
      {note && <p>{note}</p>}
      {(batches.error || generate.error || ready.error) && (
        <p className="error">{batches.error?.message ?? generate.error?.message ?? ready.error?.message}</p>
      )}
      {batches.data?.length === 0 && <p className="muted">No batches yet.</p>}
      {batches.data && batches.data.length > 0 && (
        <DataTable>
          <thead>
            <tr>
              <th>Made</th>
              <th>Codes</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {batches.data.map((b) => (
              <tr key={b.id}>
                <td>
                  {fmtTime(b.createdAt)}
                  <div className="muted small">{b.period ? `Monthly, ${b.period}` : 'By hand'}</div>
                </td>
                <td title={b.plans.map((p) => `${p.planName}: ${p.count}`).join('\n')}>{b.codeCount}</td>
                <td>
                  <StatusBadge status={b.readyAt ? 'loaded' : 'waiting_router'} />
                  {b.readyAt && (
                    <div className="muted small">
                      {fmtTime(b.readyAt)} by {b.readyBy}
                    </div>
                  )}
                </td>
                <td className="actions">
                  <a className="btn" href={api.batchExportUrl(b.id, 'rsc')} download>
                    MikroTik file
                  </a>
                  <a className="btn" href={api.batchExportUrl(b.id, 'csv')} download>
                    CSV
                  </a>
                  {!b.readyAt && (
                    <button className="btn" disabled={ready.isPending} onClick={() => ready.mutate(b.id)}>
                      Mark as loaded
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </Panel>
  );
}

function AddVouchers({ plans, onAdded }: { plans: { planId: string; planName: string; active: boolean }[]; onAdded: () => void }) {
  const [planId, setPlanId] = useState('');
  const [codes, setCodes] = useState('');
  const [result, setResult] = useState<AddVouchersResult | null>(null);
  const add = useMutation({
    mutationFn: () => api.addVouchers(planId, codes),
    onSuccess: (r) => {
      setResult(r);
      setCodes('');
      onAdded();
    },
  });

  // A .txt or .csv export from the Wi-Fi system: codes are read from it in the browser.
  const readFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setCodes((c) => (c ? `${c}\n` : '') + text);
    e.target.value = '';
  };

  const count = codes.split(/[\s,;]+/).filter(Boolean).length;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setResult(null);
    add.mutate();
  };

  return (
    <Panel title="Add codes">
      <form className="voucher-form" onSubmit={submit}>
        <label>
          Plan
          <select required value={planId} onChange={(e) => setPlanId(e.target.value)}>
            <option value="" disabled>
              Choose a plan
            </option>
            {plans.map((p) => (
              <option key={p.planId} value={p.planId}>
                {p.planName}
                {p.active ? '' : ' (hidden)'}
              </option>
            ))}
          </select>
        </label>
        <label>
          Codes (one per line)
          <textarea rows={6} className="mono" value={codes} onChange={(e) => setCodes(e.target.value)} placeholder={'AB12CD34\nEF56GH78\n…'} />
        </label>
        <div className="row">
          <label className="btn file-btn">
            From file
            <input type="file" accept=".txt,.csv,text/plain,text/csv" onChange={readFile} hidden />
          </label>
          <button className="btn primary" disabled={!planId || count === 0 || add.isPending}>
            {add.isPending ? 'Adding…' : `Add ${count || ''} code${count === 1 ? '' : 's'}`}
          </button>
        </div>
        {add.error && <p className="error">{add.error.message}</p>}
        {result && (
          <div className="result">
            <p>
              <StatusBadge status="done" /> Added {result.added}.
              {result.assignedToWaiting > 0 && ` ${result.assignedToWaiting} waiting order${result.assignedToWaiting === 1 ? '' : 's'} got a code.`}
            </p>
            {result.duplicates.length > 0 && (
              <p className="muted">
                {result.duplicates.length} already added: <span className="mono">{preview(result.duplicates)}</span>
              </p>
            )}
            {result.invalid.length > 0 && (
              <p className="error">
                {result.invalid.length} invalid: <span className="mono">{preview(result.invalid)}</span>
              </p>
            )}
          </div>
        )}
      </form>
    </Panel>
  );
}

const preview = (codes: string[]) => codes.slice(0, 10).join(', ') + (codes.length > 10 ? ` and ${codes.length - 10} more` : '');
