import type { ReactNode } from 'react';

export type BannerTone = 'info' | 'success' | 'warn' | 'error';

const TONES: Record<BannerTone, string> = {
  info: 'border-sky-300 bg-sky-50 text-sky-950',
  success: 'border-emerald-300 bg-emerald-50 text-emerald-950',
  warn: 'border-amber-300 bg-amber-50 text-amber-950',
  error: 'border-red-300 bg-red-50 text-red-950',
};

const LABELS: Record<BannerTone, string> = { info: 'Notice', success: 'Success', warn: 'Warning', error: 'Error' };

/** Errors use role="alert" (announced immediately); everything else role="status". Tone is never conveyed by colour alone. */
export function Banner({ tone, title, children, onDismiss, className = '' }: { tone: BannerTone; title?: string; children?: ReactNode; onDismiss?: () => void; className?: string }) {
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`rounded-md border p-4 text-sm ${TONES[tone]} ${className}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold">
            <span className="sr-only">{LABELS[tone]}: </span>
            {title}
          </p>
          {children && <div className={title ? 'mt-1' : ''}>{children}</div>}
        </div>
        {onDismiss && (
          <button type="button" onClick={onDismiss} className="rounded px-2 text-lg leading-none focus-visible:outline-2 focus-visible:outline-indigo-600" aria-label="Dismiss message">
            ×
          </button>
        )}
      </div>
    </div>
  );
}
