BEGIN;

ALTER TABLE outreach.draft_research_packets
  ADD COLUMN IF NOT EXISTS temporal_status text NOT NULL DEFAULT 'blocked',
  ADD COLUMN IF NOT EXISTS temporal_audit jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE outreach.email_drafts
  ADD COLUMN IF NOT EXISTS temporal_status text NOT NULL DEFAULT 'blocked',
  ADD COLUMN IF NOT EXISTS temporal_audit jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS draft_grounding jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE outreach.draft_research_packets
   SET status = 'stale',
       temporal_status = 'blocked',
       temporal_audit = jsonb_build_object(
         'policyVersion', 'outreach-timeliness-v2',
         'status', 'blocked',
         'codes', jsonb_build_array('LEGACY_PACKET_SCHEMA'),
         'auditedAt', now()
       ),
       updated_at = now()
 WHERE schema_version IS DISTINCT FROM '2'
    OR jsonb_typeof(packet->'schemaVersion') IS DISTINCT FROM 'string'
    OR packet->>'schemaVersion' IS DISTINCT FROM '2';

UPDATE outreach.email_drafts AS draft
   SET temporal_status = 'blocked',
       temporal_audit = jsonb_build_object(
         'policyVersion', 'outreach-timeliness-v2',
         'status', 'blocked',
         'codes', jsonb_build_array('LEGACY_PACKET_SCHEMA'),
         'auditedAt', now()
       ),
       updated_at = now()
  FROM outreach.draft_research_packets AS packet
 WHERE packet.drafting_item_id = draft.drafting_item_id
   AND packet.status = 'stale'
   AND packet.temporal_audit->'codes' ? 'LEGACY_PACKET_SCHEMA';

COMMIT;
