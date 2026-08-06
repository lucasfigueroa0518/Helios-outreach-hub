import fs from 'node:fs';
import { probeMailboxEmail } from '@/lib/mailbox-verify';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
}

const result = await probeMailboxEmail(
  'test-probe@example.com',
  '00000000-0000-0000-0000-000000000099',
  { sleep: async () => undefined },
);
console.log(JSON.stringify(result, null, 2));
