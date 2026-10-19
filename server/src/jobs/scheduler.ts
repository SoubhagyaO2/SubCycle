import cron from 'node-cron';
import type { JobCycleSummary } from '../services/renewalService';

export interface JobRunner {
  /** Runs one cycle unless one is already running in this process. Other processes are safe via row claims (B19). */
  tick(): Promise<'ran' | 'skipped'>;
}

/** Wraps a job cycle with an overlap guard and error containment (a failing cycle never kills the scheduler). */
export function createJobRunner(
  run: () => Promise<JobCycleSummary>,
  hooks: { onSummary?: (s: JobCycleSummary) => void; onError?: (err: unknown) => void } = {},
): JobRunner {
  let running = false;
  return {
    async tick() {
      if (running) return 'skipped';
      running = true;
      try {
        const summary = await run(); // not inside the optional call: it must run even without an onSummary hook
        hooks.onSummary?.(summary);
      } catch (err) {
        hooks.onError?.(err);
      } finally {
        running = false;
      }
      return 'ran';
    },
  };
}

/** Only logs when something noteworthy happened; counts only, never payment data. */
export function logSummary(s: JobCycleSummary): void {
  const r = s.renewals.outcomes;
  const noteworthy = r.renewed + r.canceled + r.declined + r.discarded + r.in_progress + r.resolved_pending;
  const rec = s.reconciliation;
  const reconNoteworthy = rec.applied + rec.declined + rec.discarded + rec.unresolved + rec.refunds.succeeded + rec.refunds.failed;
  if (noteworthy === 0 && reconNoteworthy === 0 && s.renewals.errors.length === 0) return;
  console.log(
    `[jobs] renewals: renewed=${r.renewed} canceled=${r.canceled} declined=${r.declined} discarded=${r.discarded} in_progress=${r.in_progress} errors=${s.renewals.errors.length}` +
      ` | reconcile: applied=${rec.applied} declined=${rec.declined} unresolved=${rec.unresolved} refunds(ok=${rec.refunds.succeeded} failed=${rec.refunds.failed} pending=${rec.refunds.pending})`,
  );
}

export function startScheduler(schedule: string, runner: JobRunner): { stop(): void } {
  if (!cron.validate(schedule)) throw new Error('Invalid JOBS_CRON expression');
  const task = cron.schedule(schedule, () => {
    void runner.tick();
  });
  return {
    stop: () => {
      void task.stop();
    },
  };
}
