// One-off diagnostic: run the live primary research pass against a small,
// fixed set of real companies and print the RAW report — including any
// `low` confidence format/domain evidence that lib/enrichment.ts would
// normally discard before building an inferred email. Not part of any
// automated test; run manually, costs live Anthropic API + web_search fees.
import fs from 'node:fs';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
}

import { researchCompanyLive } from '@/lib/research-provider';
import { buildDisambiguation } from '@/lib/research-types';

const companies = [
  'Vista Equity Partners',
  'Thoma Bravo',
  'Bain Capital',
  'Court Square Capital Partners',
  'New Mountain Capital',
  'Trilantic Capital Partners',
  'Palladium Equity Partners',
];

async function main() {
  const results: unknown[] = [];
  for (const companyName of companies) {
    const disambiguation = buildDisambiguation(companyName, [{
      lead_id: `probe-${companyName}`,
      full_name: 'Unnamed Contact',
      first_name: 'Unnamed',
      last_name: 'Contact',
      title: null,
      location: null,
      email: null,
    }]);
    console.log(`\n=== ${companyName} ===`);
    try {
      const report = await researchCompanyLive(disambiguation);
      const lowFormats = report.formats.filter((f) => f.confidence === 'low');
      const usableFormats = report.formats.filter((f) => f.confidence !== 'low');
      const lowDomains = (report.email_domains ?? []).filter((d) => d.confidence === 'low');
      console.log(`domain: ${report.domain} (${report.domain_confidence})`);
      console.log(`literal_emails: ${report.literal_emails.length}`);
      console.log(`formats KEPT (medium/high): ${JSON.stringify(usableFormats, null, 2)}`);
      console.log(`formats DISCARDED (low confidence): ${JSON.stringify(lowFormats, null, 2)}`);
      console.log(`email_domains DISCARDED (low confidence): ${JSON.stringify(lowDomains, null, 2)}`);
      console.log(`searches used: ${report.research_searches_used}`);
      results.push({ company: companyName, report });
    } catch (error) {
      console.error(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
      results.push({ company: companyName, error: String(error) });
    }
  }
  fs.writeFileSync('scripts/probe_format_confidence.output.json', JSON.stringify(results, null, 2));
}

main().catch((error) => { console.error(error); process.exit(1); });
