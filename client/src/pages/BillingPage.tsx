import { Banner } from '../components/Banner';
import { EmptyState, ErrorState, LoadingState, PageHeader } from '../components/States';
import { Badge } from '../components/StatusBadge';
import { useApi } from '../context/AuthContext';
import { useResource } from '../hooks/useResource';
import { INVOICE_KIND, invoiceStatus, operationLabel, operationStatus } from '../lib/billing';
import { formatDate, formatDateTime, formatMoney } from '../lib/format';

export function BillingPage() {
  const api = useApi();
  const invoices = useResource((signal) => api.invoices({ signal }), [api]);
  const operations = useResource((signal) => api.operations({ signal }), [api]);

  const ops = operations.data ?? [];
  const failedRefunds = ops.filter((o) => o.type === 'refund' && o.status === 'failed');
  const pendingCharges = ops.filter((o) => o.type === 'charge' && o.status === 'pending');
  const pendingRefunds = ops.filter((o) => o.type === 'refund' && o.status === 'pending');

  return (
    <>
      <PageHeader title="Billing" />
      <div className="space-y-6">
        {failedRefunds.length > 0 && (
          <Banner tone="error" title={`${failedRefunds.length === 1 ? 'A refund' : `${failedRefunds.length} refunds`} could not be completed`}>
            The payment provider rejected the refund. It is shown below as “Refund failed” with a reference number to quote to support. It has not been refunded.
          </Banner>
        )}
        {pendingCharges.length > 0 && (
          <Banner tone="info" title="A payment is still being confirmed">
            We have not received a final answer from the payment provider yet. Nothing is marked as paid until it is confirmed, and you will not be charged twice.
          </Banner>
        )}
        {pendingRefunds.length > 0 && failedRefunds.length === 0 && (
          <Banner tone="info" title="A refund is on its way">
            A payment was reversed because your subscription changed while it was processing.
          </Banner>
        )}

        <section aria-labelledby="invoices-heading" className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <h2 id="invoices-heading" className="text-lg font-semibold text-slate-900">
            Invoices
          </h2>
          {invoices.loading && <LoadingState label="Loading invoices" />}
          {invoices.error && !invoices.data && <ErrorState error={invoices.error} onRetry={invoices.reload} title="Could not load invoices" />}
          {invoices.data && invoices.data.length === 0 && (
            <div className="mt-3">
              <EmptyState title="No invoices yet">Invoices appear here after your first paid charge. Free plans and zero-amount changes do not create invoices.</EmptyState>
            </div>
          )}
          {invoices.data && invoices.data.length > 0 && (
            <ul aria-label="Invoices as cards, newest first" className="mt-3 space-y-3 sm:hidden">
              {invoices.data.map((inv) => {
                const st = invoiceStatus(inv.status);
                return (
                  <li key={inv.id} className="rounded-md border border-slate-200 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-medium text-slate-900">{INVOICE_KIND[inv.kind]}</p>
                        <p className="text-xs text-slate-600">{inv.description}</p>
                      </div>
                      <Badge tone={st.tone}>{st.label}</Badge>
                    </div>
                    <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-slate-700">
                      <dt>Amount</dt>
                      <dd className="font-medium">{formatMoney(inv.amountCents)}</dd>
                      <dt>Date</dt>
                      <dd>{formatDate(inv.createdAt)}</dd>
                      <dt>Period start</dt>
                      <dd>{formatDate(inv.billingPeriodStart)}</dd>
                    </dl>
                  </li>
                );
              })}
            </ul>
          )}
          {invoices.data && invoices.data.length > 0 && (
            <div className="mt-3 hidden overflow-x-auto sm:block">
              <table className="w-full min-w-[34rem] text-left text-sm">
                <caption className="sr-only">Invoices, newest first</caption>
                <thead className="border-b border-slate-200 text-slate-600">
                  <tr>
                    <th scope="col" className="py-2 pr-3 font-medium">Date</th>
                    <th scope="col" className="py-2 pr-3 font-medium">Description</th>
                    <th scope="col" className="py-2 pr-3 font-medium">Period start</th>
                    <th scope="col" className="py-2 pr-3 text-right font-medium">Amount</th>
                    <th scope="col" className="py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {invoices.data.map((inv) => {
                    const st = invoiceStatus(inv.status);
                    return (
                      <tr key={inv.id}>
                        <td className="py-3 pr-3 whitespace-nowrap">{formatDate(inv.createdAt)}</td>
                        <td className="py-3 pr-3">
                          <span className="font-medium text-slate-900">{INVOICE_KIND[inv.kind]}</span>
                          <span className="block text-xs text-slate-600">{inv.description}</span>
                        </td>
                        <td className="py-3 pr-3 whitespace-nowrap">{formatDate(inv.billingPeriodStart)}</td>
                        <td className="py-3 pr-3 text-right whitespace-nowrap">{formatMoney(inv.amountCents)}</td>
                        <td className="py-3">
                          <Badge tone={st.tone}>{st.label}</Badge>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section aria-labelledby="attempts-heading" className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <h2 id="attempts-heading" className="text-lg font-semibold text-slate-900">
            Payment attempts and refunds
          </h2>
          <p className="mt-1 text-sm text-slate-600">Every attempt to collect or return money, including ones that failed or are still being confirmed.</p>
          {operations.loading && <LoadingState label="Loading payment attempts" />}
          {operations.error && !operations.data && <ErrorState error={operations.error} onRetry={operations.reload} title="Could not load payment attempts" />}
          {operations.data && ops.length === 0 && (
            <div className="mt-3">
              <EmptyState title="No payment attempts yet" />
            </div>
          )}
          {operations.data && ops.length > 0 && (
            <ul aria-label="Payment attempts and refunds as cards, newest first" className="mt-3 space-y-3 sm:hidden">
              {ops.map((op) => {
                const st = operationStatus(op);
                return (
                  <li key={op.id} className="rounded-md border border-slate-200 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-medium text-slate-900">{operationLabel(op)}</p>
                        {op.attempt > 1 && op.type === 'charge' && <p className="text-xs text-slate-600">Attempt {op.attempt}</p>}
                      </div>
                      <Badge tone={st.tone}>{st.label}</Badge>
                    </div>
                    <p className="mt-2 text-xs text-slate-700">
                      <span className="font-medium">{formatMoney(op.amountCents)}</span> · {formatDateTime(op.createdAt)}
                    </p>
                    {st.note && <p className="mt-1 text-xs text-slate-700">{st.note}</p>}
                  </li>
                );
              })}
            </ul>
          )}
          {operations.data && ops.length > 0 && (
            <div className="mt-3 hidden overflow-x-auto sm:block">
              <table className="w-full min-w-[34rem] text-left text-sm">
                <caption className="sr-only">Payment attempts and refunds, newest first</caption>
                <thead className="border-b border-slate-200 text-slate-600">
                  <tr>
                    <th scope="col" className="py-2 pr-3 font-medium">Time</th>
                    <th scope="col" className="py-2 pr-3 font-medium">What</th>
                    <th scope="col" className="py-2 pr-3 text-right font-medium">Amount</th>
                    <th scope="col" className="py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {ops.map((op) => {
                    const st = operationStatus(op);
                    return (
                      <tr key={op.id}>
                        <td className="py-3 pr-3 whitespace-nowrap align-top">{formatDateTime(op.createdAt)}</td>
                        <td className="py-3 pr-3 align-top">
                          <span className="font-medium text-slate-900">{operationLabel(op)}</span>
                          {op.attempt > 1 && op.type === 'charge' && <span className="block text-xs text-slate-600">Attempt {op.attempt}</span>}
                        </td>
                        <td className="py-3 pr-3 text-right whitespace-nowrap align-top">{formatMoney(op.amountCents)}</td>
                        <td className="py-3 align-top">
                          <Badge tone={st.tone}>{st.label}</Badge>
                          {st.note && <p className="mt-1 max-w-md text-xs text-slate-700">{st.note}</p>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section aria-labelledby="billing-notes" className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <h2 id="billing-notes" className="text-lg font-semibold text-slate-900">
            How billing works
          </h2>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-slate-700">
            <li>Renewals are charged at the end of each period, and access stops at that moment until the renewal has been processed (usually within a minute).</li>
            <li>If a renewal payment fails you keep access for 72 hours while we retry (after about 1, 2 and 3 days). If it still fails, the subscription is canceled.</li>
            <li>
              If renewals were delayed, <strong>missed periods are not forgiven</strong>: each one is charged and invoiced separately, one period at a time.
            </li>
            <li>
              Billing dates can drift at the end of a month. A renewal that falls on the 31st moves to the last day of a shorter month and keeps that earlier date afterwards (for example 31 Jan → 28 Feb → 28 Mar).
            </li>
            <li>An upgrade is charged for the remaining part of the current period only; a downgrade takes effect at the end of the period without a refund.</li>
          </ul>
        </section>
      </div>
    </>
  );
}
