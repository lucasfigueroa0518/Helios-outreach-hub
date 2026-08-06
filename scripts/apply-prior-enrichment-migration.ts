import fs from 'node:fs';
import path from 'node:path';
import { dbQuery } from '@/lib/db';

function loadLocalEnvironment() {
  const envPath = path.join(process.cwd(), '.env.local');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}

loadLocalEnvironment();

async function main() {
  await dbQuery(
    `ALTER TABLE outreach.campaign_leads
       ADD COLUMN IF NOT EXISTS prior_enrichment_pending boolean NOT NULL DEFAULT false`,
  );
  await dbQuery(
    `ALTER TABLE outreach.campaign_leads
       ADD COLUMN IF NOT EXISTS prior_enrichment_lead_id uuid REFERENCES outreach.leads (id)`,
  );
  await dbQuery(
    `CREATE INDEX IF NOT EXISTS idx_campaign_leads_prior_pending
       ON outreach.campaign_leads (run_id)
       WHERE prior_enrichment_pending`,
  );
  console.log('prior enrichment migration applied');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
