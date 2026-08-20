import { addCalendarDays } from '@/lib/drafting/send-queue-schedule';
import { isNyWeekday } from '@/lib/auto-campaigns/schedule';
import { nyWallTimeToUtc } from '@/lib/drafting/send-queue-schedule';
import type { AutoQueueColor, LeadAttributes } from '@/lib/auto-campaigns/types';

export type LiveAutoReservationSource = {
  campaignId: string;
  campaignName: string;
  emailsPerDay: number;
  queueColor: AutoQueueColor | string | null;
  leadAttributes: LeadAttributes;
  expansionStep: number;
  queuedOrSentByDate: Record<string, number>;
};

export type AutoQueueReservation = {
  campaign_id: string;
  campaign_name: string;
  schedule_date: string;
  reserved: number;
  emails_per_day: number;
  already_slotted: number;
  queue_color: string;
  lead_attributes: LeadAttributes;
  expansion_step: number;
};

export function weekdayDatesInclusive(from: string, to: string): string[] {
  const dates: string[] = [];
  let cursor = from;
  while (cursor <= to) {
    const noon = nyWallTimeToUtc(cursor, 12, 0);
    if (isNyWeekday(noon)) dates.push(cursor);
    cursor = addCalendarDays(cursor, 1);
  }
  return dates;
}

export function computeAutoReservations(input: {
  today: string;
  from: string;
  to: string;
  campaigns: LiveAutoReservationSource[];
}): AutoQueueReservation[] {
  const start = input.from < input.today ? input.today : input.from;
  const dates = weekdayDatesInclusive(start, input.to);
  const locks: AutoQueueReservation[] = [];
  for (const campaign of input.campaigns) {
    const perDay = Math.max(0, Math.floor(campaign.emailsPerDay) || 0);
    if (perDay <= 0) continue;
    const color = campaign.queueColor?.trim() || 'chart-1';
    for (const date of dates) {
      const slotted = campaign.queuedOrSentByDate[date] ?? 0;
      const reserved = Math.max(0, perDay - slotted);
      if (reserved <= 0) continue;
      locks.push({
        campaign_id: campaign.campaignId,
        campaign_name: campaign.campaignName,
        schedule_date: date,
        reserved,
        emails_per_day: perDay,
        already_slotted: slotted,
        queue_color: color,
        lead_attributes: campaign.leadAttributes,
        expansion_step: campaign.expansionStep,
      });
    }
  }
  return locks;
}
