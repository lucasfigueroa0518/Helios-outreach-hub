import fs from 'node:fs';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) process.env[match[1].trim()] = match[2].trim();
}

import { agentMailSendProbe, agentMailListMessages } from '@/lib/agentmail';

async function main() {
  try {
    const sent = await agentMailSendProbe('test@example.com', '00000000-0000-0000-0000-000000000001');
    console.log('send OK:', sent);
    const messages = await agentMailListMessages({ limit: 3 });
    console.log('list OK:', messages.length, 'messages');
  } catch (error) {
    console.error('FAIL:', error instanceof Error ? error.message : error);
  }
}

main();
