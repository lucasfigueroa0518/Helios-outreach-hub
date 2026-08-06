'use client';

import { useEffect, useRef, useState } from 'react';

type Row = {
  id: string;
  display_id: string;
  first_name: string | null;
  last_name: string | null;
  credentials: string | null;
  email_primary: string | null;
  email_alt_1: string | null;
  email_alt_2: string | null;
  email_status: string;
  email_status_label: string;
  email_verification: string | null;
  email_verification_label: string;
  email_mx_status: string | null;
  email_source_note: string | null;
  title: string | null;
  company_name: string | null;
  location: string | null;
  linkedin_url: string | null;
  profile_enrichment: Partial<Record<'title' | 'company_name' | 'location', { value?: string }>>;
  reused_from_prior_lead: boolean;
  relationship_snapshot: {
    past_work?: string;
    prior_relationship_date?: string | null;
    last_contacted?: string | null;
    last_contacted_by?: string | null;
    relationship_tier?: string;
  } | null;
  extra_fields?: Record<string, string> | null;
};

function rowQualityClass(row: Row) {
  return [
    row.reused_from_prior_lead ? 'sheet-row--prior-lead' : '',
    !row.email_primary || row.email_status_label === 'Not Found' ? 'sheet-row--missing-email' : '',
  ].filter(Boolean).join(' ');
}

function emailVerificationClass(status: string | null | undefined) {
  if (status === 'valid') return 'email-verify-chip--valid';
  if (status === 'invalid') return 'email-verify-chip--invalid';
  if (status === 'pending') return 'email-verify-chip--pending';
  if (status === 'unknown') return 'email-verify-chip--unknown';
  if (status === 'rate_limited') return 'email-verify-chip--rate_limited';
  return '';
}

function emailStatusClass(status: string) {
  if (status === 'direct' || status === 'from_embark_db') return 'email-status-chip--found';
  if (status === 'inferred') return 'email-status-chip--inferred';
  if (status === 'format_guess') return 'email-status-chip--format-guess';
  return 'email-status-chip--not-found';
}

function priorRelationshipActivityLabel(tier: string | undefined) {
  if (tier === 'active') return 'Within 6 months';
  if (tier === 'dormant') return 'Older than 6 months';
  return '';
}

export function ReviewTable({
  campaignId,
  initialRows,
  pollWhileEnriching = false,
  pollWhileVerifying = false,
}: {
  campaignId: string;
  initialRows: Row[];
  pollWhileEnriching?: boolean;
  pollWhileVerifying?: boolean;
}) {
  const [rows, setRows] = useState(initialRows);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const requestSequence = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    setRows(initialRows);
  }, [initialRows]);

  useEffect(() => {
    if (!pollWhileEnriching && !pollWhileVerifying) return;

    const load = async () => {
      const sequence = ++requestSequence.current;
      activeRequest.current?.abort();
      const controller = new AbortController();
      activeRequest.current = controller;
      try {
        const response = await fetch(`/api/campaigns/${campaignId}/sheet?sync=0`, {
          signal: controller.signal,
        });
        const data = await response.json();
        if (sequence !== requestSequence.current) return;
        if (!response.ok) {
          setError(data.error ?? 'Unable to load sheet');
          return;
        }
        setRows(data.rows);
        setError(null);
      } catch (loadError) {
        if (controller.signal.aborted) return;
        setError('Connection failed — refresh once the server is back up.');
      } finally {
        if (sequence === requestSequence.current && !controller.signal.aborted) {
          setLoading(false);
        }
      }
    };

    setLoading(true);
    void load();
    const timer = window.setInterval(() => void load(), 5_000);
    return () => {
      window.clearInterval(timer);
      activeRequest.current?.abort();
    };
  }, [campaignId, pollWhileEnriching, pollWhileVerifying]);

  if (loading && !rows.length) {
    return (
      <div className="run-progress" role="status">
        <span className="loading-spinner" aria-hidden="true" />
        <span>Loading enriched leads…</span>
      </div>
    );
  }
  if (error && !rows.length) return <p className="field__error">{error}</p>;
  if (!rows.length) {
    return (
      <div className="empty-state">
        <strong>No leads on the sheet yet</strong>
        <span>Upload a CSV or Excel file on the Upload tab, run Enrich, then return here. Extracted people will appear as rows in this table.</span>
      </div>
    );
  }

  const extraColumns = Array.from(
    new Set(rows.flatMap((row) => Object.keys(row.extra_fields ?? {}))),
  );

  return (
    <div className="review-sheet">
      {error ? <p className="field__error" role="status">{error}</p> : null}
      <div className="review-guide">
        <div className="review-guide__intro">
          <strong>Review your enriched leads</strong>
          <p>
            Check the emails found for each lead, along with job titles, companies,
            and locations added during enrichment. Use the color guide to quickly spot
            enriched details, missing emails, and prior relationships.
          </p>
        </div>
        <div className="review-guide__key" aria-label="Table color guide">
          <strong>Color guide</strong>
          <div className="review-guide__items">
            <div className="review-guide__item">
              <span className="legend-chip legend-chip--enriched">Enriched detail</span>
              <span>Job title, company, or location was added</span>
            </div>
            <div className="review-guide__item">
              <span className="legend-chip legend-chip--missing">Missing email</span>
              <span>This lead still needs an email</span>
            </div>
            <div className="review-guide__item">
              <span className="legend-chip legend-chip--prior">Prior relationship</span>
              <span>Recent or older activity exists</span>
            </div>
            <div className="review-guide__item">
              <span className="legend-chip legend-chip--prior-lead">Past lead</span>
              <span>Information was reused from an earlier lead enrichment</span>
            </div>
          </div>
        </div>
      </div>
      <div className="sheet-table-wrap">
        <table className="data-table review-table">
          <thead>
            <tr>
              <th>First Name</th>
              <th>Last Name</th>
              <th>Email</th>
              <th>Email Alt 1</th>
              <th>Email Alt 2</th>
              <th>Email Status</th>
              <th>Mailbox Verify</th>
              <th>Email Source</th>
              <th>Job Title</th>
              <th>Company</th>
              <th>Location</th>
              <th>Past Work</th>
              <th>Prior Relationship Activity</th>
              {extraColumns.map((column) => <th key={column}>{column}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const tier = row.relationship_snapshot?.relationship_tier ?? 'cold';
              const activity = priorRelationshipActivityLabel(tier);
              return (
                <tr className={`data-table__row ${rowQualityClass(row)}`} key={row.id}>
                  <td>
                    <span className="sheet-name">
                      {row.first_name ?? ''}
                      {row.reused_from_prior_lead
                        ? <span className="prior-lead-marker" title="Information reused from an earlier lead enrichment">Past lead</span>
                        : null}
                    </span>
                  </td>
                  <td>{row.last_name ?? ''}</td>
                  <td><span className="email-value">{row.email_primary ?? ''}</span></td>
                  <td>{row.email_alt_1 ?? ''}</td>
                  <td>{row.email_alt_2 ?? ''}</td>
                  <td>
                    <span className={`status-chip email-status-chip ${emailStatusClass(row.email_status)}`}>
                      {row.email_status_label}
                    </span>
                  </td>
                  <td>
                    {row.email_verification_label ? (
                      <span className={`status-chip email-verify-chip ${emailVerificationClass(row.email_verification)}`}>
                        {row.email_verification_label}
                      </span>
                    ) : ''}
                  </td>
                  <td>{row.email_source_note ?? ''}</td>
                  <td className={row.profile_enrichment?.title ? 'sheet-cell--non-email-enriched' : undefined}>{row.title ?? ''}</td>
                  <td className={row.profile_enrichment?.company_name ? 'sheet-cell--non-email-enriched' : undefined}>{row.company_name ?? ''}</td>
                  <td className={row.profile_enrichment?.location ? 'sheet-cell--non-email-enriched' : undefined}>{row.location ?? ''}</td>
                  <td>{row.relationship_snapshot?.past_work ?? ''}</td>
                  <td>{activity ? <span className={`tier-chip tier-chip--${tier}`}>{activity}</span> : ''}</td>
                  {extraColumns.map((column) => (
                    <td key={column}>{row.extra_fields?.[column] ?? ''}</td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="review-sheet__count">{rows.length} lead{rows.length === 1 ? '' : 's'} on this campaign sheet</p>
    </div>
  );
}
