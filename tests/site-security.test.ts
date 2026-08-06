import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyDirectEmailSource } from '@/lib/site-scraper';

test('direct source verification blocks private network URLs before fetch', async () => {
  let called = false;
  const result = await verifyDirectEmailSource({
    source_url: 'http://127.0.0.1/admin',
    email: 'jane.doe@acme.com',
    person_name: 'Jane Doe',
    domain: 'acme.com',
  }, {
    fetchImpl: async () => {
      called = true;
      return new Response('Jane Doe jane.doe@acme.com');
    },
  });
  assert.equal(result.verified, false);
  assert.match(result.error ?? '', /private network/);
  assert.equal(called, false);
});

test('direct source verification blocks credential-bearing URLs', async () => {
  const result = await verifyDirectEmailSource({
    source_url: 'https://user:pass@acme.com/team',
    email: 'jane.doe@acme.com',
    person_name: 'Jane Doe',
    domain: 'acme.com',
  }, {
    fetchImpl: async () => new Response('unused'),
  });
  assert.equal(result.verified, false);
  assert.match(result.error ?? '', /unsafe URL/);
});

test('direct source verification blocks hexadecimal IPv4-mapped IPv6 loopback', async () => {
  let called = false;
  const result = await verifyDirectEmailSource({
    source_url: 'http://[::ffff:7f00:1]/admin',
    email: 'jane.doe@acme.com',
    person_name: 'Jane Doe',
    domain: 'acme.com',
  }, {
    fetchImpl: async () => {
      called = true;
      return new Response('unused');
    },
  });
  assert.equal(result.verified, false);
  assert.match(result.error ?? '', /private network/);
  assert.equal(called, false);
});
