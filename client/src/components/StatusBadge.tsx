import { PHASE_LABEL, PHASE_TONE, type Phase, type Tone } from '../lib/subscriptionState';

const TONES: Record<Tone, string> = {
  good: 'bg-emerald-100 text-emerald-900 ring-emerald-600/30',
  warn: 'bg-amber-100 text-amber-900 ring-amber-600/30',
  bad: 'bg-red-100 text-red-900 ring-red-600/30',
  neutral: 'bg-slate-100 text-slate-800 ring-slate-500/30',
};

export function Badge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${TONES[tone]}`}>{children}</span>;
}

export function StatusBadge({ phase }: { phase: Phase }) {
  return <Badge tone={PHASE_TONE[phase]}>{PHASE_LABEL[phase]}</Badge>;
}
