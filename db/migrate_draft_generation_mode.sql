BEGIN;

ALTER TABLE outreach.email_drafts
  ADD COLUMN IF NOT EXISTS generation_mode text;

UPDATE outreach.email_drafts
   SET generation_mode = 'legacy'
 WHERE generation_mode IS NULL
    OR generation_mode NOT IN ('live', 'stub', 'legacy');

ALTER TABLE outreach.email_drafts
  ALTER COLUMN generation_mode SET DEFAULT 'legacy',
  ALTER COLUMN generation_mode SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'email_drafts_generation_mode_check'
        AND conrelid = 'outreach.email_drafts'::regclass
    ) THEN
      ALTER TABLE outreach.email_drafts
        ADD CONSTRAINT email_drafts_generation_mode_check
        CHECK (generation_mode IN ('live', 'stub', 'legacy')) NOT VALID;
    END IF;
END $$;

COMMIT;
