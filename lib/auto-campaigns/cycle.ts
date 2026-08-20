import { createApolloRestClient } from '@/lib/auto-campaigns/apollo';
import { persistEnrichedApolloPeople } from '@/lib/auto-campaigns/ingest';
import { mapAttributesToSearchParams } from '@/lib/auto-campaigns/filter-map';
import { runPeopleSearchProspecting } from '@/lib/auto-campaigns/prospect';
import {
  appendProspectLog,
  createProspectRun,
  loadAttachedOnNyDate,
  loadAutoCampaign,
  loadKnownApolloIds,
  loadKnownLinkedinUrls,
  loadQueuedOrSentEmails,
  ownerHasReadySender,
  saveProspectRunStats,
  updateAutoCursor,
} from '@/lib/auto-campaigns/repository';
import { MAX_EXPANSION_STEP, type AutoStatus } from '@/lib/auto-campaigns/types';
import {
  nextAutoCycleAfterCompletion,
  THIN_DAYS_BEFORE_EXHAUST,
} from '@/lib/auto-campaigns/schedule';
import { campaignHasDraftingWorkspace } from '@/lib/campaign-review';
import { dbQuery } from '@/lib/db';
import { lateSyncIdempotencyKey } from '@/lib/drafting/late-sync';
import {
  startDraftingWorkspace,
  syncCampaignLeadsIntoDraftingWorkspace,
} from '@/lib/drafting/repository';
import { enqueueReadyAutoCampaignDrafts } from '@/lib/auto-campaigns/auto-send';
import { formatNyDate } from '@/lib/drafting/send-queue-schedule';
import { normalizeLinkedinUrl } from '@/lib/auto-campaigns/credit-pipeline';
import type { EnrichedPerson, ProspectCycleStats, ProspectLogEntry } from '@/lib/auto-campaigns/types';

function stubStats(
  campaign: { apollo_search_page: number; expansion_step: number },
  log: ProspectLogEntry[],
): ProspectCycleStats {
  return {
    page_start: campaign.apollo_search_page,
    page_end: campaign.apollo_search_page,
    searches: 0,
    enrich_attempted: 0,
    enrich_verified: 0,
    skipped_known: 0,
    leads_attached: 0,
    expansion_step: campaign.expansion_step,
    log,
  };
}

function logNow(kind: ProspectLogEntry['kind'], message: string, extra: Partial<ProspectLogEntry> = {}): ProspectLogEntry {
  return { at: new Date().toISOString(), kind, message, ...extra };
}

function rememberHits(people: EnrichedPerson[], knownIds: Set<string>, knownLinkedin: Set<string>): void {
  for (const person of people) {
    knownIds.add(person.apolloPersonId);
    const linkedin = normalizeLinkedinUrl(person.linkedinUrl);
    if (linkedin) knownLinkedin.add(linkedin);
  }
}

async function kickAutoDrafting(
  campaignId: string,
  ownerId: string,
  runId?: string,
): Promise<void> {
  const workspaceExists = await campaignHasDraftingWorkspace(campaignId);
  if (workspaceExists) {
    const workspace = await dbQuery<{ id: string }>(
      `SELECT id FROM outreach.drafting_workspaces WHERE campaign_id = $1`,
      [campaignId],
    );
    const workspaceId = workspace.rows[0]?.id;
    if (workspaceId) {
      await syncCampaignLeadsIntoDraftingWorkspace(campaignId, ownerId, {
        trigger: 'retry',
        idempotencyKey: lateSyncIdempotencyKey(workspaceId, runId ?? `quota:${formatNyDate()}`),
        budgetCapUsd: '999999.0000',
      });
    }
  } else {
    await startDraftingWorkspace(campaignId, ownerId, {
      idempotencyKey: `auto-cycle:${campaignId}:${runId ?? formatNyDate()}`,
      budgetCapUsd: '999999.0000',
    });
  }
  await enqueueReadyAutoCampaignDrafts(campaignId, ownerId);
}

export async function runAutoCampaignCycle(campaignId: string): Promise<{
  attached: number;
  runId: string;
  status: string;
}> {
  const campaign = await loadAutoCampaign(campaignId);
  if (!campaign || campaign.kind !== 'auto') {
    throw new Error('Auto campaign not found');
  }
  if (campaign.auto_status !== 'live') {
    return { attached: 0, runId: '', status: campaign.auto_status ?? 'paused' };
  }

  const senderReady = await ownerHasReadySender(
    campaign.owner_id,
    campaign.sender_identity_slug,
  );
  if (!senderReady) {
    await updateAutoCursor({
      campaignId,
      page: campaign.apollo_search_page,
      autoStatus: 'pending_sender',
      autoError: 'Sender signature is required before Auto can run',
    });
    return { attached: 0, runId: '', status: 'pending_sender' };
  }

  const emailsPerDay = Math.max(0, Math.floor(campaign.emails_per_day ?? 0));
  const today = formatNyDate();
  const attachedAtStart = await loadAttachedOnNyDate(campaignId, today);
  if (emailsPerDay > 0 && attachedAtStart >= emailsPerDay) {
    await updateAutoCursor({
      campaignId,
      page: campaign.apollo_search_page,
      nextCycleAt: nextAutoCycleAfterCompletion(campaignId),
      lastCycleAt: new Date(),
      thinDays: 0,
      autoStatus: 'live',
      autoError: null,
    });
    await kickAutoDrafting(campaignId, campaign.owner_id);
    return { attached: 0, runId: '', status: 'live' };
  }

  const runId = await createProspectRun(campaignId, campaign.owner_id);
  try {
    const opening: ProspectLogEntry[] = [
      logNow('map', 'Cycle started. Mapping targeting to Apollo people-search filters.'),
    ];
    await appendProspectLog(runId, stubStats(campaign, opening));

    let searchParams = campaign.apollo_search_params;
    if (!searchParams) {
      const mapped = await mapAttributesToSearchParams(campaign.lead_attributes);
      searchParams = mapped.params;
      opening.push(logNow('map', 'Filters ready. Starting free people search.'));
      await appendProspectLog(runId, stubStats(campaign, opening));
      await updateAutoCursor({ campaignId, page: campaign.apollo_search_page, searchParams });
    } else {
      opening.push(logNow('map', 'Resuming saved people-search filters.'));
      await appendProspectLog(runId, stubStats(campaign, opening));
    }

    const [knownApolloIds, knownLinkedinUrls] = await Promise.all([
      loadKnownApolloIds(),
      loadKnownLinkedinUrls(),
    ]);
    const queuedOrSent = await loadQueuedOrSentEmails(campaign.owner_id);

    let page = campaign.apollo_search_page;
    let expansionStep = campaign.expansion_step;
    let attachedToday = await loadAttachedOnNyDate(campaignId, today);
    let remaining = emailsPerDay - attachedToday;
    opening.push(logNow(
      'result',
      remaining <= 0
        ? `Today already has ${attachedToday} of ${emailsPerDay} verified leads.`
        : `Need ${remaining} more verified leads today (${attachedToday} of ${emailsPerDay} attached).`,
      { count: remaining },
    ));
    await appendProspectLog(runId, stubStats({ apollo_search_page: page, expansion_step: expansionStep }, opening));

    const combined = stubStats({ apollo_search_page: page, expansion_step: expansionStep }, [...opening]);
    let cycleAttached = 0;
    let lastInventoryExhausted = false;

    while (remaining > 0 && expansionStep <= MAX_EXPANSION_STEP) {
      const prospected = await runPeopleSearchProspecting(createApolloRestClient(), {
        emailsPerDay: remaining,
        page,
        searchParams,
        expansionStep,
        knownApolloIds,
        knownLinkedinUrls,
      });
      combined.log.push(...prospected.stats.log);
      combined.searches += prospected.stats.searches;
      combined.enrich_attempted += prospected.stats.enrich_attempted;
      combined.enrich_verified += prospected.stats.enrich_verified;
      combined.skipped_known += prospected.stats.skipped_known;
      combined.page_end = prospected.pageEnd;
      combined.expansion_step = expansionStep;
      await appendProspectLog(runId, combined);

      rememberHits(
        [...prospected.attached, ...prospected.storedWithoutEmail],
        knownApolloIds,
        knownLinkedinUrls,
      );

      const blockedByQueue = prospected.attached.filter((person) => {
        const email = person.email?.trim().toLowerCase();
        return Boolean(email && queuedOrSent.has(email));
      });
      const attachable = prospected.attached.filter((person) => {
        const email = person.email?.trim().toLowerCase();
        return Boolean(email && !queuedOrSent.has(email));
      });
      for (const person of attachable) {
        const email = person.email?.trim().toLowerCase();
        if (email) queuedOrSent.add(email);
      }

      await persistEnrichedApolloPeople({
        campaignId,
        runId,
        expansionStep,
        people: [...prospected.storedWithoutEmail, ...blockedByQueue],
        attachVerified: false,
      });
      const persisted = await persistEnrichedApolloPeople({
        campaignId,
        runId,
        expansionStep,
        people: attachable,
        attachVerified: true,
      });
      cycleAttached += persisted.attached;
      page = prospected.pageEnd;
      lastInventoryExhausted = prospected.inventoryExhausted;

      attachedToday = await loadAttachedOnNyDate(campaignId, today);
      remaining = emailsPerDay - attachedToday;
      await updateAutoCursor({
        campaignId,
        page,
        searchParams,
        expansionStep,
      });

      if (remaining <= 0) break;

      if (prospected.inventoryExhausted) {
        if (expansionStep >= MAX_EXPANSION_STEP) break;
        expansionStep += 1;
        page = 1;
        combined.log.push(logNow(
          'expand',
          `Still short ${remaining} verified leads. Widening search (step ${expansionStep}) and continuing today.`,
          { count: expansionStep },
        ));
        combined.expansion_step = expansionStep;
        await updateAutoCursor({ campaignId, page: 1, searchParams, expansionStep });
        await appendProspectLog(runId, combined);
        continue;
      }

      break;
    }

    attachedToday = await loadAttachedOnNyDate(campaignId, today);
    remaining = emailsPerDay - attachedToday;
    const filled = remaining <= 0;
    let thinDays = campaign.thin_days;
    if (filled) thinDays = 0;
    else if (lastInventoryExhausted && expansionStep >= MAX_EXPANSION_STEP) {
      thinDays = campaign.thin_days + 1;
    }
    let autoStatus: AutoStatus = 'live';
    if (
      !filled
      && lastInventoryExhausted
      && expansionStep >= MAX_EXPANSION_STEP
      && thinDays >= THIN_DAYS_BEFORE_EXHAUST
    ) {
      autoStatus = 'exhausted';
    }

    const nextCycleAt = autoStatus !== 'live'
      ? null
      : filled
        ? nextAutoCycleAfterCompletion(campaignId)
        : new Date();

    await updateAutoCursor({
      campaignId,
      page,
      searchParams,
      expansionStep,
      thinDays,
      autoStatus,
      autoError: autoStatus === 'exhausted'
        ? 'Exact and similar profiles are exhausted'
        : null,
      nextCycleAt,
      lastCycleAt: new Date(),
    });

    combined.leads_attached = cycleAttached;
    combined.page_end = page;
    combined.expansion_step = expansionStep;
    combined.log.push(logNow(
      'result',
      filled
        ? `Attached ${attachedToday} verified leads for today (quota ${emailsPerDay}).`
        : `Attached ${attachedToday} of ${emailsPerDay} verified leads today. Continuing until the quota is filled.`,
      { count: attachedToday },
    ));
    await saveProspectRunStats(runId, combined);

    if (cycleAttached > 0) {
      await kickAutoDrafting(campaignId, campaign.owner_id, runId);
    }

    return { attached: cycleAttached, runId, status: autoStatus };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Auto cycle failed';
    await saveProspectRunStats(runId, {
      page_start: campaign.apollo_search_page,
      page_end: campaign.apollo_search_page,
      searches: 0,
      enrich_attempted: 0,
      enrich_verified: 0,
      skipped_known: 0,
      leads_attached: 0,
      expansion_step: campaign.expansion_step,
      log: [{ at: new Date().toISOString(), kind: 'error', message }],
    }, message);
    await updateAutoCursor({
      campaignId,
      page: campaign.apollo_search_page,
      autoStatus: 'error',
      autoError: message.slice(0, 2000),
      nextCycleAt: nextAutoCycleAfterCompletion(campaignId),
    });
    throw error;
  }
}
