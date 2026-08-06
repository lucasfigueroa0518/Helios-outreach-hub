-- db/bootstrap.sql — Helios no longer loads Embark Salesforce/PitchBook dumps.
-- Historical CSVs were exported to ~/HELIOS/archives/embark-sf-snapshot-*/
-- and the original import files remain under pe-relationships-sf/output/.
-- This file only ensures shared extensions and retires the old public tables.
\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS pg_trgm;

DROP VIEW IF EXISTS outreach.all_people CASCADE;

DROP TABLE IF EXISTS public.pitchbook_sister_cos CASCADE;
DROP TABLE IF EXISTS public.pitchbook_firms CASCADE;
DROP TABLE IF EXISTS public.call_participants CASCADE;
DROP TABLE IF EXISTS public.opportunities CASCADE;
DROP TABLE IF EXISTS public.contacts CASCADE;
DROP TABLE IF EXISTS public.accounts CASCADE;
