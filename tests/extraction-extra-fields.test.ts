import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractUpload } from '@/lib/extraction';
import { isLinkedinRelationshipHeader, LINKEDIN_RELATIONSHIP_LABEL } from '@/lib/models';

function csv(text: string) {
  return Buffer.from(text, 'utf8');
}

test('csv extraction captures non-canonical columns as extra fields', async () => {
  const bytes = csv(
    [
      'Name,Email,Job Title,Company,Connection Status,Priority',
      'Jane Doe,jane@acme.com,VP Eng,Acme,1st,High',
    ].join('\n'),
  );
  const result = await extractUpload(bytes, 'leads.csv', 'upload-1');
  assert.equal(result.people.length, 1);
  const person = result.people[0];
  // Canonical fields still map normally and never leak into extra.
  assert.equal(person.title, 'VP Eng');
  assert.equal(person.company, 'Acme');
  assert.ok(person.extra, 'expected extra fields');
  // "Connection Status" is recognized and normalized to the stable LinkedIn label.
  assert.equal(person.extra?.[LINKEDIN_RELATIONSHIP_LABEL], '1st');
  // Arbitrary user column passes through under its own header.
  assert.equal(person.extra?.Priority, 'High');
  // Canonical headers are not duplicated into extra.
  assert.equal(person.extra?.Company, undefined);
  assert.equal(person.extra?.Email, undefined);
});

test('csv with only canonical columns yields no extra fields', async () => {
  const bytes = csv(['First Name,Last Name,Email', 'Sam,Lee,sam@x.com'].join('\n'));
  const result = await extractUpload(bytes, 'leads.csv', 'upload-2');
  assert.equal(result.people.length, 1);
  assert.equal(result.people[0].extra, undefined);
});

test('linkedin relationship header detection is conservative', () => {
  assert.equal(isLinkedinRelationshipHeader('LinkedIn Relationship'), true);
  assert.equal(isLinkedinRelationshipHeader('linkedin connection'), true);
  assert.equal(isLinkedinRelationshipHeader('Connection Degree'), true);
  assert.equal(isLinkedinRelationshipHeader('Relationship Status'), true);
  // Unrelated columns must not be renamed.
  assert.equal(isLinkedinRelationshipHeader('Relationship'), false);
  assert.equal(isLinkedinRelationshipHeader('Priority'), false);
  assert.equal(isLinkedinRelationshipHeader('Account'), false);
});
