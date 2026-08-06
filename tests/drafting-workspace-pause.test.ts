import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  canPauseDraftingWorkspace,
  isDraftingWorkspacePaused,
  WORKSPACE_CANCEL_RUN_MESSAGE,
  WORKSPACE_PAUSED_MESSAGE,
} from '../lib/drafting/workspace-pause.js';

describe('drafting workspace pause helpers', () => {
  it('detects paused workspace status', () => {
    assert.equal(isDraftingWorkspacePaused('paused'), true);
    assert.equal(isDraftingWorkspacePaused('active'), false);
    assert.equal(isDraftingWorkspacePaused(undefined), false);
  });

  it('allows pause only from active workspaces', () => {
    assert.equal(canPauseDraftingWorkspace('active'), true);
    assert.equal(canPauseDraftingWorkspace('paused'), false);
  });

  it('exposes user-facing resume copy', () => {
    assert.match(WORKSPACE_PAUSED_MESSAGE, /Resume/i);
  });

  it('documents cancel run copy', () => {
    assert.match(WORKSPACE_CANCEL_RUN_MESSAGE, /Cancel Run/i);
  });
});
