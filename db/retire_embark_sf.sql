-- One-shot retirement of Embark Salesforce/PitchBook seed tables + dead helpers.
-- Safe to re-run. Export CSVs BEFORE running (see ~/HELIOS/archives/).
\set ON_ERROR_STOP on

DROP VIEW IF EXISTS outreach.all_people CASCADE;
DROP TABLE IF EXISTS outreach.drafting_resolutions CASCADE;

DROP TABLE IF EXISTS public.pitchbook_sister_cos CASCADE;
DROP TABLE IF EXISTS public.pitchbook_firms CASCADE;
DROP TABLE IF EXISTS public.call_participants CASCADE;
DROP TABLE IF EXISTS public.opportunities CASCADE;
DROP TABLE IF EXISTS public.contacts CASCADE;
DROP TABLE IF EXISTS public.accounts CASCADE;
