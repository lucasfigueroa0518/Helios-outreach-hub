import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { loadDraftingAssets } from '@/lib/drafting/assets';
import { isLiveDraftingResearchReady } from '@/lib/drafting/research-provider';
import { isLiveDraftingWriterReady } from '@/lib/drafting/writer-provider';
import {
  DRAFTING_ADVERSARIAL_MODEL,
  DRAFTING_RESEARCH_MODEL,
  DRAFTING_WRITER_MODEL,
  getDraftingMode,
} from '@/lib/models';

export type LiveDraftingReadiness = {
  ready: boolean;
  draftingMode: 'stub' | 'live';
  anthropicKeyPresent: boolean;
  researchProviderReady: boolean;
  writerProviderReady: boolean;
  assetsLoadable: boolean;
  researchModel: string;
  adversarialModel: string;
  writerModel: string;
  providerModulesPresent: boolean;
  blockers: string[];
};

/** Offline readiness check — never calls Claude or web_search. */
export async function getLiveDraftingReadiness(): Promise<LiveDraftingReadiness> {
  const draftingMode = getDraftingMode();
  const anthropicKeyPresent = Boolean(process.env.ANTHROPIC_API_KEY?.trim());
  const researchProviderReady = isLiveDraftingResearchReady();
  const writerProviderReady = isLiveDraftingWriterReady();

  const root = process.cwd();
  const providerModulesPresent = [
    'lib/drafting/research-provider.ts',
    'lib/drafting/writer-provider.ts',
    'lib/drafting/research-prompt.ts',
    'lib/drafting/writer-prompt.ts',
    'lib/drafting/provider-parse.ts',
  ].every((relative) => existsSync(path.join(root, relative)));

  let assetsLoadable = false;
  const blockers: string[] = [];
  try {
    await loadDraftingAssets({ forceReload: true });
    assetsLoadable = true;
  } catch (error) {
    blockers.push(error instanceof Error ? error.message : String(error));
  }

  if (draftingMode !== 'live') blockers.push('DRAFTING_MODE is not live');
  if (!anthropicKeyPresent) blockers.push('ANTHROPIC_API_KEY is missing');
  if (!providerModulesPresent) blockers.push('Live provider module files are missing');
  if (!researchProviderReady) blockers.push('Live research provider is not ready');
  if (!writerProviderReady) blockers.push('Live writer provider is not ready');

  // Confirm live paths are no longer stub-throw stubs.
  try {
    const researchSrc = readFileSync(path.join(root, 'lib/drafting/research-provider.ts'), 'utf8');
    const writerSrc = readFileSync(path.join(root, 'lib/drafting/writer-provider.ts'), 'utf8');
    if (researchSrc.includes('Live drafting research provider is not implemented yet')) {
      blockers.push('research-provider still contains unimplemented live stub');
    }
    if (writerSrc.includes('Live drafting writer provider is not implemented yet')) {
      blockers.push('writer-provider still contains unimplemented live stub');
    }
  } catch {
    blockers.push('Unable to verify provider source files');
  }

  return {
    ready: blockers.length === 0,
    draftingMode,
    anthropicKeyPresent,
    researchProviderReady,
    writerProviderReady,
    assetsLoadable,
    researchModel: DRAFTING_RESEARCH_MODEL,
    adversarialModel: DRAFTING_ADVERSARIAL_MODEL,
    writerModel: DRAFTING_WRITER_MODEL,
    providerModulesPresent,
    blockers,
  };
}
