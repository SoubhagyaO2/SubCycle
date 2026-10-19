/** All business-logic time comes from a Clock. Never call `new Date()` / `Date.now()` elsewhere (lint-enforced). */
export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** Controllable clock for tests and the dev-only fake-clock mode. */
export class FakeClock implements Clock {
  private current: Date;

  constructor(start: Date | string | number) {
    this.current = new Date(start);
    if (Number.isNaN(this.current.getTime())) throw new Error('FakeClock: invalid start time');
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  set(time: Date | string | number): void {
    const next = new Date(time);
    if (Number.isNaN(next.getTime())) throw new Error('FakeClock: invalid time');
    this.current = next;
  }

  advanceMs(ms: number): void {
    if (!Number.isFinite(ms)) throw new Error('FakeClock: invalid duration');
    this.current = new Date(this.current.getTime() + ms);
  }
}
