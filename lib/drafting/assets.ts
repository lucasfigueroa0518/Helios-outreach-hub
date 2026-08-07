import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { hashDraftingTextAsset, sha256Buffer } from '@/lib/drafting/asset-hash';
import type { EmbarkCapability } from '@/lib/drafting/types';

const DRAFTING_RESOURCES_DIR = path.join(process.cwd(), 'resources', 'drafting');

const REQUIRED_FILES = {
  skill: 'first-contact-outreach-v5.md',
  subjectLine: 'subject-line-v1.md',
  positioningText: 'helios-positioning-v1.md',
  positioningPdf: 'helios-positioning-v1.pdf',
  capabilities: 'embark-capabilities-v1.json',
  manifest: 'manifest.json',
} as const;

export type DraftingAssetManifestEntry = {
  name: string;
  file: string;
  version: string;
  sha256: string;
  bytes: number;
  textSha256?: string;
};

export type DraftingAssetManifest = {
  version: string;
  approvedAt?: string;
  assets: DraftingAssetManifestEntry[];
};

export type LoadedDraftingAssets = {
  skill: {
    version: string;
    content: string;
    sha256: string;
    bytes: number;
  };
  subjectLine: {
    version: string;
    content: string;
    sha256: string;
    bytes: number;
  };
  positioning: {
    version: string;
    text: string;
    textSha256: string;
    pdfSha256: string | null;
    bytes: number;
  };
  capabilities: {
    version: string;
    catalog: EmbarkCapability[];
    sha256: string;
    bytes: number;
  };
  manifest: DraftingAssetManifest | null;
  versions: {
    skillVersion: string;
    skillSha256: string;
    subjectLineVersion: string;
    subjectLineSha256: string;
    positioningVersion: string;
    positioningSha256: string;
    capabilityCatalogVersion: string;
    capabilityCatalogSha256: string;
  };
};

export class MissingDraftingAssetsError extends Error {
  readonly missingFiles: string[];

  constructor(missingFiles: string[]) {
    super(
      `Missing required drafting assets in ${DRAFTING_RESOURCES_DIR}: ${missingFiles.join(', ')}. `
      + 'See planning/drafting/02-research-and-writing-architecture.md for the canonical layout.',
    );
    this.name = 'MissingDraftingAssetsError';
    this.missingFiles = missingFiles;
  }
}

export class DraftingAssetHashMismatchError extends Error {
  readonly code = 'asset_hash_mismatch' as const;

  constructor(message: string) {
    super(message);
    this.name = 'DraftingAssetHashMismatchError';
  }
}

let memoizedAssets: LoadedDraftingAssets | null = null;

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readRequiredFile(relativePath: string): Promise<Buffer> {
  const absolute = path.join(DRAFTING_RESOURCES_DIR, relativePath);
  return readFile(absolute);
}

function versionFromFilename(filename: string, fallback: string): string {
  const match = filename.match(/-v(\d+(?:\.\d+)*)/i);
  return match ? `v${match[1]}` : fallback;
}

function findManifestEntry(
  manifest: DraftingAssetManifest | null,
  names: string[],
): DraftingAssetManifestEntry | undefined {
  if (!manifest) return undefined;
  return manifest.assets.find((entry) => names.includes(entry.name));
}

function assertManifestHash(
  label: string,
  actual: string,
  expected: string | undefined,
): void {
  if (!expected) {
    throw new DraftingAssetHashMismatchError(
      `${label} missing from resources/drafting/manifest.json — run npm run drafting:sync-manifest`,
    );
  }
  if (actual !== expected.toLowerCase()) {
    throw new DraftingAssetHashMismatchError(
      `${label} SHA-256 mismatch: computed ${actual}, manifest expects ${expected}. `
      + 'After editing drafting assets, run: npm run drafting:sync-manifest',
    );
  }
}

/** Load canonical drafting assets once per process. Throws on missing required files. */
export async function loadDraftingAssets(options: { forceReload?: boolean } = {}): Promise<LoadedDraftingAssets> {
  if (memoizedAssets && !options.forceReload) {
    return memoizedAssets;
  }

  const missing: string[] = [];
  for (const file of Object.values(REQUIRED_FILES)) {
    const exists = await fileExists(path.join(DRAFTING_RESOURCES_DIR, file));
    if (!exists) missing.push(file);
  }
  if (missing.length > 0) {
    throw new MissingDraftingAssetsError(missing);
  }

  const [
    skillBuf,
    subjectLineBuf,
    positioningTextBuf,
    positioningPdfBuf,
    capabilitiesBuf,
    manifestBuf,
  ] = await Promise.all([
    readRequiredFile(REQUIRED_FILES.skill),
    readRequiredFile(REQUIRED_FILES.subjectLine),
    readRequiredFile(REQUIRED_FILES.positioningText),
    readRequiredFile(REQUIRED_FILES.positioningPdf),
    readRequiredFile(REQUIRED_FILES.capabilities),
    readRequiredFile(REQUIRED_FILES.manifest),
  ]);

  const manifest = JSON.parse(manifestBuf.toString('utf8')) as DraftingAssetManifest;
  const skillHashed = hashDraftingTextAsset(skillBuf);
  const subjectLineHashed = hashDraftingTextAsset(subjectLineBuf);
  const positioningHashed = hashDraftingTextAsset(positioningTextBuf);
  const capabilitiesHashed = hashDraftingTextAsset(capabilitiesBuf);
  const positioningPdfSha256 = sha256Buffer(positioningPdfBuf);

  const skillManifest = findManifestEntry(manifest, ['skill', 'first-contact-outreach']);
  const subjectLineManifest = findManifestEntry(manifest, ['subject-line', 'subjectLine']);
  const positioningManifest = findManifestEntry(manifest, ['positioning', 'positioning-text']);
  const capabilitiesManifest = findManifestEntry(manifest, ['capabilities', 'capability-catalog']);

  assertManifestHash('skill', skillHashed.sha256, skillManifest?.sha256);
  assertManifestHash('subject-line', subjectLineHashed.sha256, subjectLineManifest?.sha256);
  assertManifestHash(
    'positioning text',
    positioningHashed.sha256,
    positioningManifest?.textSha256 ?? positioningManifest?.sha256,
  );
  assertManifestHash('capabilities', capabilitiesHashed.sha256, capabilitiesManifest?.sha256);

  const catalog = JSON.parse(capabilitiesHashed.text) as EmbarkCapability[];
  const skillVersion = skillManifest?.version ?? versionFromFilename(REQUIRED_FILES.skill, 'v5');
  const subjectLineVersion = subjectLineManifest?.version
    ?? versionFromFilename(REQUIRED_FILES.subjectLine, 'v1');
  const positioningVersion = positioningManifest?.version ?? versionFromFilename(REQUIRED_FILES.positioningText, 'v1');
  const capabilityCatalogVersion = capabilitiesManifest?.version ?? versionFromFilename(REQUIRED_FILES.capabilities, 'v1');

  memoizedAssets = {
    skill: {
      version: skillVersion,
      content: skillHashed.text,
      sha256: skillHashed.sha256,
      bytes: skillHashed.bytes,
    },
    subjectLine: {
      version: subjectLineVersion,
      content: subjectLineHashed.text,
      sha256: subjectLineHashed.sha256,
      bytes: subjectLineHashed.bytes,
    },
    positioning: {
      version: positioningVersion,
      text: positioningHashed.text,
      textSha256: positioningHashed.sha256,
      pdfSha256: positioningPdfSha256,
      bytes: positioningHashed.bytes,
    },
    capabilities: {
      version: capabilityCatalogVersion,
      catalog,
      sha256: capabilitiesHashed.sha256,
      bytes: capabilitiesHashed.bytes,
    },
    manifest,
    versions: {
      skillVersion,
      skillSha256: skillHashed.sha256,
      subjectLineVersion,
      subjectLineSha256: subjectLineHashed.sha256,
      positioningVersion,
      positioningSha256: positioningHashed.sha256,
      capabilityCatalogVersion,
      capabilityCatalogSha256: capabilitiesHashed.sha256,
    },
  };

  return memoizedAssets;
}

/** Synchronous accessor after loadDraftingAssets has warmed the cache. */
export function getDraftingAssetsOrThrow(): LoadedDraftingAssets {
  if (!memoizedAssets) {
    throw new Error('Drafting assets not loaded. Call loadDraftingAssets() during server startup.');
  }
  return memoizedAssets;
}

export function clearDraftingAssetsCache(): void {
  memoizedAssets = null;
}
