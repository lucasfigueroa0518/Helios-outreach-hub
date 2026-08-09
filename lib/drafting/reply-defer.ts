/**
 * Resolve natural-language deferrals ("mid month", "later this quarter", "the 20th")
 * into a calendar date for the follow-up queue.
 */

export type DeferResolution = {
  deferUntil: string; // YYYY-MM-DD
  source: 'explicit_iso' | 'parsed' | 'default';
  label: string;
};

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function formatDateOnly(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function addDays(base: Date, days: number): Date {
  const d = new Date(base.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function nextWeekday(from: Date, weekday: number): Date {
  // 0=Sun … 4=Thu …
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const delta = (weekday - d.getUTCDay() + 7) % 7 || 7;
  return addDays(d, delta);
}

/** Morning UTC of a YYYY-MM-DD (worker uses timestamptz). */
export function deferUntilToScheduledFor(deferUntil: string, hourUtc = 14): Date {
  const match = deferUntil.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error(`Invalid deferUntil: ${deferUntil}`);
  const y = Number(match[1]);
  const m = Number(match[2]);
  const day = Number(match[3]);
  return new Date(Date.UTC(y, m - 1, day, hourUtc, 0, 0));
}

/**
 * Resolve a defer target. Prefers explicit ISO from the model; otherwise parses
 * common phrases from the lead text + model reason.
 */
export function resolveDeferUntil(input: {
  explicitIso?: string | null;
  leadText: string;
  deferReason?: string | null;
  now?: Date;
}): DeferResolution {
  const now = input.now ?? new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  const explicit = (input.explicitIso ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(explicit)) {
    const parsed = new Date(`${explicit}T00:00:00.000Z`);
    if (!Number.isNaN(parsed.getTime()) && parsed.getTime() >= today.getTime()) {
      return { deferUntil: explicit, source: 'explicit_iso', label: 'model_iso' };
    }
  }

  const hay = `${input.leadText}\n${input.deferReason ?? ''}`.toLowerCase();

  // the 20th / on the 20th
  const dayNum = hay.match(/\b(?:the|on)\s+(\d{1,2})(?:st|nd|rd|th)?\b/);
  if (dayNum) {
    const day = Number(dayNum[1]);
    if (day >= 1 && day <= 31) {
      let candidate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), day));
      if (candidate.getTime() <= today.getTime()) {
        candidate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, day));
      }
      return {
        deferUntil: formatDateOnly(candidate),
        source: 'parsed',
        label: `day_${day}`,
      };
    }
  }

  if (/\bmid[\s-]?month\b/.test(hay)) {
    const midThis = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 15));
    const target = midThis.getTime() > today.getTime()
      ? midThis
      : new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 15));
    return { deferUntil: formatDateOnly(target), source: 'parsed', label: 'mid_month' };
  }

  if (/\blater this quarter\b|\bnext quarter\b|\bend of (the )?quarter\b/.test(hay)) {
    const month = today.getUTCMonth(); // 0-11
    const quarterEndMonth = Math.floor(month / 3) * 3 + 2; // 2,5,8,11
    let y = today.getUTCFullYear();
    let m = quarterEndMonth;
    // Aim ~2 weeks before quarter end, or mid next quarter if "next quarter"
    if (/\bnext quarter\b/.test(hay)) {
      m = quarterEndMonth + 3;
      if (m > 11) {
        m -= 12;
        y += 1;
      }
      const target = new Date(Date.UTC(y, m - 1, 15)); // mid of first month of that quarter-ish
      // first month of next quarter:
      const nqStart = quarterEndMonth + 1;
      let ny = today.getUTCFullYear();
      let nm = nqStart;
      if (nm > 11) {
        nm -= 12;
        ny += 1;
      }
      const midNextQ = new Date(Date.UTC(ny, nm, 15));
      return { deferUntil: formatDateOnly(midNextQ), source: 'parsed', label: 'next_quarter' };
    }
    const target = new Date(Date.UTC(y, m, 15));
    if (target.getTime() <= today.getTime()) {
      const nm = m + 1;
      const ny = nm > 11 ? y + 1 : y;
      return {
        deferUntil: formatDateOnly(new Date(Date.UTC(ny, nm % 12, 15))),
        source: 'parsed',
        label: 'later_this_quarter',
      };
    }
    return { deferUntil: formatDateOnly(target), source: 'parsed', label: 'later_this_quarter' };
  }

  if (/\bnext week\b/.test(hay)) {
    return {
      deferUntil: formatDateOnly(addDays(today, 7)),
      source: 'parsed',
      label: 'next_week',
    };
  }

  if (/\bthursday\b/.test(hay)) {
    return {
      deferUntil: formatDateOnly(nextWeekday(today, 4)),
      source: 'parsed',
      label: 'thursday',
    };
  }
  if (/\btuesday\b/.test(hay)) {
    return {
      deferUntil: formatDateOnly(nextWeekday(today, 2)),
      source: 'parsed',
      label: 'tuesday',
    };
  }

  // Default: ~3 weeks out when they said "later" vaguely
  return {
    deferUntil: formatDateOnly(addDays(today, 21)),
    source: 'default',
    label: 'default_21d',
  };
}
