import fs from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { agentMailListMessages, agentMailSendProbe } from '@/lib/agentmail';
import { renderSitePage } from '@/lib/site-browser-render';
import { MAPPING_MODEL } from '@/lib/models';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) process.env[match[1].trim()] = match[2].trim();
}

type Result = { name: string; ok: boolean; detail: string };

const results: Result[] = [];

async function testClaude() {
  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    results.push({ name: 'Claude API', ok: false, detail: 'ANTHROPIC_API_KEY missing' });
    return;
  }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });
  const message = await client.messages.create({
    model: MAPPING_MODEL,
    max_tokens: 16,
    messages: [{ role: 'user', content: 'Reply with exactly: pong' }],
  });
  const text = message.content.find((block) => block.type === 'text');
  const body = text?.type === 'text' ? text.text.trim() : '';
  results.push({
    name: 'Claude API',
    ok: body.length > 0,
    detail: `model=${message.model} reply="${body.slice(0, 40)}"`,
  });
}

async function testWebSearch() {
  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    results.push({ name: 'Claude web_search', ok: false, detail: 'ANTHROPIC_API_KEY missing' });
    return;
  }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });
  const message = await client.messages.create({
    model: MAPPING_MODEL,
    max_tokens: 120,
    messages: [{
      role: 'user',
      content: 'Use web_search once. What is the official website domain of Anthropic? Reply with only the domain.',
    }],
    tools: [{
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: 1,
    }],
    tool_choice: { type: 'auto' },
  });
  const searches = Number(
    (message.usage as Anthropic.Message['usage'] & {
      server_tool_use?: { web_search_requests?: number };
    }).server_tool_use?.web_search_requests ?? 0,
  );
  const text = message.content
    .flatMap((block) => block.type === 'text' ? [block.text] : [])
    .join(' ')
    .trim();
  results.push({
    name: 'Claude web_search',
    ok: searches >= 1 && text.length > 0,
    detail: `searches=${searches} answer="${text.slice(0, 80)}"`,
  });
}

async function testBrowser() {
  if (!process.env.BROWSER_RENDER_URL?.trim()) {
    results.push({
      name: 'Managed browser',
      ok: false,
      detail: 'BROWSER_RENDER_URL not set in .env.local',
    });
    return;
  }
  const rendered = await renderSitePage(new URL('https://example.com'), { timeoutMs: 15_000 });
  results.push({
    name: 'Managed browser',
    ok: rendered.html.includes('Example Domain'),
    detail: `finalUrl=${rendered.finalUrl} htmlBytes=${rendered.html.length}`,
  });
}

async function testAgentMail() {
  if (!process.env.AGENT_MAIL_API?.trim()) {
    results.push({ name: 'AgentMail', ok: false, detail: 'AGENT_MAIL_API missing' });
    return;
  }
  const sent = await agentMailSendProbe('smoke-test@example.com', '00000000-0000-0000-0000-smoke0001');
  const messages = await agentMailListMessages({ limit: 2 });
  results.push({
    name: 'AgentMail',
    ok: Boolean(sent.message_id) && Array.isArray(messages),
    detail: `send=${sent.message_id} inboxMessages=${messages.length}`,
  });
}

async function main() {
  const tests = [
    ['Claude API', testClaude],
    ['Claude web_search', testWebSearch],
    ['Managed browser', testBrowser],
    ['AgentMail', testAgentMail],
  ] as const;

  for (const [label, fn] of tests) {
    try {
      await fn();
    } catch (error) {
      results.push({
        name: label,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  console.log('\nLive integration smoke results:');
  for (const result of results) {
    console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}: ${result.detail}`);
  }
  if (results.some((result) => !result.ok)) process.exit(1);
}

main();
