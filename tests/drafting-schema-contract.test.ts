import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DRAFTING_REQUIRED_COLUMNS,
  DRAFTING_REQUIRED_FUNCTIONS,
  DRAFTING_REQUIRED_TABLES,
  formatDraftingSchemaDrift,
} from '../lib/drafting/schema-contract';

test('schema contract covers Go to Drafting execution_epoch drift class', () => {
  assert.ok(
    DRAFTING_REQUIRED_COLUMNS.some(
      (column) => column.table === 'outreach.drafting_jobs'
        && column.column === 'execution_epoch',
    ),
    'drafting_jobs.execution_epoch must stay in the runtime schema contract',
  );
});

test('schema contract covers append-only cost persistence boundary', () => {
  assert.ok(
    DRAFTING_REQUIRED_TABLES.includes('outreach.drafting_job_cost_events'),
  );
  assert.ok(
    DRAFTING_REQUIRED_FUNCTIONS.some(
      (fn) => fn.name === 'record_drafting_job_cost_event',
    ),
  );
});

test('schema drift formatter tells operators how to repair', () => {
  const message = formatDraftingSchemaDrift(['column outreach.drafting_jobs.execution_epoch']);
  assert.match(message, /npm run db:drafting/);
  assert.match(message, /execution_epoch/);
});
