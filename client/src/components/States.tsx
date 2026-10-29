import type { ReactNode } from 'react';
import type { ApiError } from '../api/client';
import { Button } from './Button';

export function LoadingState({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="flex items-center gap-3 py-10 text-sm text-muted">
      <span aria-hidden="true" className="size-5 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" />
      <span>{label}…</span>
    </div>
  );
}

export function ErrorState({ error, onRetry, title = 'Could not load this information' }: { error: ApiError; onRetry?: () => void; title?: string }) {
  return (
    <div role="alert" className="rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-900">
      <p className="font-semibold">{title}</p>
      <p className="mt-1">{error.message}</p>
      {onRetry && (
        <Button variant="secondary" className="mt-3" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-line bg-surface p-8 text-center">
      <h2 className="text-base font-semibold text-ink">{title}</h2>
      {children && <div className="mt-1 text-sm text-muted">{children}</div>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
      {children}
    </div>
  );
}
