import { differenceInCalendarDays, format } from 'date-fns';

type Props = {
  startDate: Date;
  targetEndDate: Date;
  mvpDelivered?: boolean;
};

export default function DaysProgressBar({
  startDate,
  targetEndDate,
  mvpDelivered,
}: Props) {
  if (mvpDelivered) {
    return (
      <div className="mx-auto w-full max-w-[680px] text-center">
        <p className="font-heading text-[clamp(28px,3vw,42px)] font-bold leading-none tracking-tight text-fg-1">
          MVP Delivered
        </p>
        <p className="mt-3 text-body font-light text-fg-2">
          Continuous improvements ongoing
        </p>
      </div>
    );
  }

  const today = new Date();
  const daysElapsed = Math.max(0, differenceInCalendarDays(today, startDate));
  const totalDays = Math.max(1, differenceInCalendarDays(targetEndDate, startDate));
  const daysLeft = differenceInCalendarDays(targetEndDate, today);
  const pct = Math.min(100, Math.round((daysElapsed / totalDays) * 100));
  const isOverdue = daysLeft < 0;
  const isWarning = !isOverdue && daysLeft <= 7;

  const centerColor = isOverdue
    ? 'text-red-600'
    : isWarning
      ? 'text-amber-600'
      : 'text-fg-1';

  const barColor = isOverdue ? 'bg-red-500' : 'bg-[#FF5E1A]';

  return (
    <div className="mx-auto w-full max-w-[680px]">
      <div className="mb-4 flex items-baseline justify-between gap-4">
        <span className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.15em] text-fg-3">
          Day {daysElapsed} of {totalDays}
        </span>
        <span
          className={`font-heading text-[clamp(28px,3vw,42px)] font-bold leading-none tracking-tight ${centerColor}`}
        >
          {isOverdue ? 'Overdue' : `${daysLeft}d left`}
        </span>
        <span className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.15em] text-fg-3">
          {pct}% complete
        </span>
      </div>

      <div className="h-[10px] w-full overflow-hidden rounded-full bg-border-soft">
        <div
          className={`h-full rounded-full transition-all duration-700 ease-out ${barColor}`}
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="mt-2 flex justify-between">
        <span className="text-[11px] font-light text-fg-muted">
          {format(startDate, 'MMM d, yyyy')}
        </span>
        <span className="text-[11px] font-light text-fg-muted">
          {format(targetEndDate, 'MMM d, yyyy')}
        </span>
      </div>
    </div>
  );
}
