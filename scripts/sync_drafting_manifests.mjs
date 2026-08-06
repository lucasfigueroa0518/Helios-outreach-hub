/**
 * Recompute drafting manifest hashes (LF-normalized for text) and rewrite
 * hub + Eva manifests + text files so line endings cannot desync again.
 *
 * Usage: node scripts/sync_drafting_manifests.mjs
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const hubRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.join(hubRoot, '..');

const TEXT_ASSETS = [
  { name: 'skill', file: 'first-contact-outreach-v5.md', version: 'v5.1' },
  { name: 'subject-line', file: 'subject-line-v1.md', version: 'v1' },
  { name: 'positioning', file: 'helios-positioning-v1.md', version: 'v1', textShaKey: true },
  { name: 'capabilities', file: 'embark-capabilities-v1.json', version: 'v1' },
];
const BINARY_ASSETS = [
  { name: 'positioning-pdf', file: 'helios-positioning-v1.pdf', version: 'v1' },
];

function normalizeText(buffer) {
  return Buffer.from(buffer.toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n'), 'utf8');
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function syncDir(resourcesDir, label) {
  if (!fs.existsSync(resourcesDir)) {
    throw new Error(`Missing drafting resources dir (${label}): ${resourcesDir}`);
  }

  const assets = [];
  for (const entry of TEXT_ASSETS) {
    const filePath = path.join(resourcesDir, entry.file);
    const raw = fs.readFileSync(filePath);
    const normalized = normalizeText(raw);
    if (!raw.equals(normalized)) {
      fs.writeFileSync(filePath, normalized);
      console.log(`[${label}] normalized line endings: ${entry.file}`);
    }
    const digest = sha256(normalized);
    const row = {
      name: entry.name,
      file: entry.file,
      version: entry.version,
      sha256: digest,
      bytes: normalized.byteLength,
    };
    if (entry.textShaKey) row.textSha256 = digest;
    assets.push(row);
  }

  for (const entry of BINARY_ASSETS) {
    const filePath = path.join(resourcesDir, entry.file);
    const raw = fs.readFileSync(filePath);
    assets.push({
      name: entry.name,
      file: entry.file,
      version: entry.version,
      sha256: sha256(raw),
      bytes: raw.byteLength,
    });
  }

  // Keep stable order: skill, subject-line, positioning, positioning-pdf, capabilities
  const order = ['skill', 'subject-line', 'positioning', 'positioning-pdf', 'capabilities'];
  assets.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));

  const manifest = {
    version: 'v1',
    approvedAt: '2026-08-05T00:00:00.000Z',
    note: 'Helios drafting assets (LF-normalized text). Subject-line block is writer-only.',
    assets,
  };
  const manifestPath = path.join(resourcesDir, 'manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`[${label}] wrote ${manifestPath}`);
  return manifest;
}

const hubManifest = syncDir(path.join(hubRoot, 'resources', 'drafting'), 'hub');
const evaDir = path.join(repoRoot, 'backend', 'resources', 'outreach-drafting');
if (fs.existsSync(evaDir)) {
  const evaManifest = syncDir(evaDir, 'eva');
  const hubSkill = hubManifest.assets.find((a) => a.name === 'skill');
  const evaSkill = evaManifest.assets.find((a) => a.name === 'skill');
  if (!hubSkill || !evaSkill || hubSkill.sha256 !== evaSkill.sha256) {
    throw new Error('Hub/Eva skill SHA diverged after sync — dual-port content mismatch');
  }
  console.log('OK skill sha', hubSkill.sha256);
} else {
  const hubSkill = hubManifest.assets.find((a) => a.name === 'skill');
  console.log(`[hub-only] skipped eva sync (missing ${evaDir})`);
  console.log('OK skill sha', hubSkill?.sha256);
}
