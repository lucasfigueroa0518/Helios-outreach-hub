import fs from 'node:fs';
import path from 'node:path';

const schemaPath = path.join(process.cwd(), 'db', 'outreach_schema.sql');
let schema = fs.readFileSync(schemaPath, 'utf8');

schema = schema.replace(
  /-- ── Company email intelligence ──[\s\S]*?(?=-- ── Company research jobs)/,
  '',
);

schema = schema.replace(
  /    email_domains  jsonb NOT NULL DEFAULT '\[\]'::jsonb,\n    evidence_version int NOT NULL DEFAULT 0,\n    email_summary_updated_at timestamptz,\n/g,
  '',
);
schema = schema.replace(
  /    ADD COLUMN IF NOT EXISTS email_domains jsonb NOT NULL DEFAULT '\[\]'::jsonb,\n    ADD COLUMN IF NOT EXISTS evidence_version int NOT NULL DEFAULT 0,\n    ADD COLUMN IF NOT EXISTS email_summary_updated_at timestamptz;\n/g,
  '',
);
schema = schema.replace(/    email_provenance      jsonb NOT NULL DEFAULT '\{\}'::jsonb,\n/g, '');
schema = schema.replace(
  /    ADD COLUMN IF NOT EXISTS email_provenance jsonb NOT NULL DEFAULT '\{\}'::jsonb;\n/g,
  '',
);
schema = schema.replace(
  /    cohort_id           uuid REFERENCES outreach\.email_research_cohorts \(id\) ON DELETE CASCADE,\n/g,
  '',
);
schema = schema.replace(
  `ALTER TABLE outreach.company_research_jobs
    ADD COLUMN IF NOT EXISTS cohort_id uuid REFERENCES outreach.email_research_cohorts (id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS job_kind text NOT NULL DEFAULT 'primary';`,
  `ALTER TABLE outreach.company_research_jobs
    ADD COLUMN IF NOT EXISTS job_kind text NOT NULL DEFAULT 'primary';`,
);
schema = schema.replace(
  `CREATE INDEX IF NOT EXISTS idx_research_jobs_cohort
    ON outreach.company_research_jobs (cohort_id, status);

`,
  '',
);

const enqueueReplacement = `DROP FUNCTION IF EXISTS public.enqueue(text, jsonb, uuid, uuid, text);
DROP FUNCTION IF EXISTS public.enqueue(text, jsonb, uuid, text);
DROP FUNCTION IF EXISTS public.enqueue(text, jsonb, uuid);

CREATE OR REPLACE FUNCTION public.enqueue(
    p_company_key text,
    p_disambiguation jsonb,
    p_run_id uuid,
    p_job_kind text DEFAULT 'primary'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = outreach, public
AS $$
DECLARE
    v_job_id uuid;
BEGIN
    INSERT INTO outreach.company_research_jobs (
        company_key, disambiguation, requested_by_runs, job_kind, search_budget
    )
    VALUES (
        p_company_key, p_disambiguation, ARRAY[p_run_id], p_job_kind,
        CASE p_job_kind
          WHEN 'profile_rescue' THEN 4
          WHEN 'email_rescue' THEN 6
          ELSE 10
        END
    )
    ON CONFLICT (company_key) DO UPDATE SET
        disambiguation = EXCLUDED.disambiguation,
        job_kind = EXCLUDED.job_kind,
        requested_by_runs = CASE
            WHEN NOT outreach.company_research_jobs.requested_by_runs @> ARRAY[p_run_id]
            THEN array_append(outreach.company_research_jobs.requested_by_runs, p_run_id)
            ELSE outreach.company_research_jobs.requested_by_runs
        END,
        status = CASE
            WHEN outreach.company_research_jobs.status = 'failed'
                 AND outreach.company_research_jobs.attempt_count < 2
            THEN 'pending'
            ELSE outreach.company_research_jobs.status
        END,
        updated_at = now()
    RETURNING id INTO v_job_id;
    RETURN v_job_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_research_job`;

schema = schema.replace(
  /DROP FUNCTION IF EXISTS public\.enqueue\(text, jsonb, uuid\);[\s\S]*?CREATE OR REPLACE FUNCTION public\.claim_research_job/,
  enqueueReplacement,
);

schema = schema.replace(/    v_cohort_id uuid;\n/g, '');
schema = schema.replace(
  /    SELECT requested_by_runs, cohort_id INTO v_runs, v_cohort_id/,
  '    SELECT requested_by_runs INTO v_runs',
);
schema = schema.replace(
  /    IF v_cohort_id IS NOT NULL THEN[\s\S]*?    END IF;\n\n    IF v_runs IS NOT NULL THEN/,
  '    IF v_runs IS NOT NULL THEN',
);
schema = schema.replace(
  'GRANT EXECUTE ON FUNCTION public.enqueue(text, jsonb, uuid, uuid, text)',
  'GRANT EXECUTE ON FUNCTION public.enqueue(text, jsonb, uuid, text)',
);

fs.writeFileSync(schemaPath, schema);
console.log('Patched db/outreach_schema.sql');
