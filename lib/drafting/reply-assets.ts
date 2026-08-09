import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { hashDraftingTextAsset } from '@/lib/drafting/asset-hash';
import { loadDraftingAssets } from '@/lib/drafting/assets';

const DRAFTING_RESOURCES_DIR = path.join(process.cwd(), 'resources', 'drafting');

const REPLY_FILES = {
  skill: 'reply-response-v1.md',
  websiteBrief: 'helios-website-brief-v1.md',
} as const;

export type LoadedReplyAssets = {
  skill: { version: string; content: string; sha256: string; bytes: number };
  websiteBrief: { version: string; content: string; sha256: string; bytes: number };
  positioning: { version: string; text: string; textSha256: string };
};

let memoized: LoadedReplyAssets | null = null;

function versionFromFilename(filename: string, fallback: string): string {
  const match = filename.match(/-v(\d+(?:\.\d+)*)/i);
  return match ? `v${match[1]}` : fallback;
}

/** Load reply-response skill, website brief, and Helios positioning. */
export async function loadReplyAssets(options: { forceReload?: boolean } = {}): Promise<LoadedReplyAssets> {
  if (memoized && !options.forceReload) return memoized;

  const [skillBuf, websiteBuf, drafting] = await Promise.all([
    readFile(path.join(DRAFTING_RESOURCES_DIR, REPLY_FILES.skill)),
    readFile(path.join(DRAFTING_RESOURCES_DIR, REPLY_FILES.websiteBrief)),
    loadDraftingAssets(options),
  ]);

  const skill = hashDraftingTextAsset(skillBuf);
  const website = hashDraftingTextAsset(websiteBuf);

  memoized = {
    skill: {
      version: versionFromFilename(REPLY_FILES.skill, 'v1'),
      content: skill.text,
      sha256: skill.sha256,
      bytes: skill.bytes,
    },
    websiteBrief: {
      version: versionFromFilename(REPLY_FILES.websiteBrief, 'v1'),
      content: website.text,
      sha256: website.sha256,
      bytes: website.bytes,
    },
    positioning: {
      version: drafting.positioning.version,
      text: drafting.positioning.text,
      textSha256: drafting.positioning.textSha256,
    },
  };
  return memoized;
}

export function clearReplyAssetsCache(): void {
  memoized = null;
}
