import fs from 'node:fs';
import { agentMailInboxId, agentMailListMessages } from '@/lib/agentmail';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
}

async function main() {
  const inbox = agentMailInboxId();
  const msgs = await agentMailListMessages({ limit: 100 });
  const subjectA = msgs.filter((m) => (m.subject ?? '').trim() === 'a');
  const bounces = msgs.filter((m) =>
    (m.subject ?? '').includes('Delivery Status')
    || (m.from ?? '').toLowerCase().includes('mailer-daemon'),
  );
  const fromInbox = msgs.filter((m) =>
    (m.from ?? '').toLowerCase().includes(inbox.toLowerCase()),
  );

  console.log(JSON.stringify({
    total_listed: msgs.length,
    subject_a_messages: subjectA.length,
    bounce_notifications: bounces.length,
    from_our_inbox: fromInbox.length,
    subject_a_sample: subjectA.slice(0, 5).map((m) => ({
      from: m.from,
      to: m.to,
      timestamp: m.timestamp ?? m.created_at,
      in_reply_to: m.in_reply_to,
    })),
  }, null, 2));
}

main().catch(console.error);
