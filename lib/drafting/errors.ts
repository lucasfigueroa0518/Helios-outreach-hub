/** Typed errors surfaced by drafting repository handlers. */

export class DraftingNotFoundError extends Error {
  constructor(message = 'Not found') {
    super(message);
    this.name = 'DraftingNotFoundError';
  }
}

export class DraftingConflictError extends Error {
  readonly code: string;

  constructor(message: string, code = 'conflict') {
    super(message);
    this.name = 'DraftingConflictError';
    this.code = code;
  }
}

export class DraftingValidationError extends Error {
  readonly fieldErrors: Record<string, string>;

  constructor(message: string, fieldErrors: Record<string, string> = {}) {
    super(message);
    this.name = 'DraftingValidationError';
    this.fieldErrors = fieldErrors;
  }
}

export class DraftingExportBlockedError extends Error {
  readonly blockers: Array<{
    item_id: string;
    recipient: string;
    code: string;
    message: string;
  }>;

  constructor(
    blockers: DraftingExportBlockedError['blockers'],
    message = 'Draft export is not ready',
  ) {
    super(message);
    this.name = 'DraftingExportBlockedError';
    this.blockers = blockers;
  }
}
