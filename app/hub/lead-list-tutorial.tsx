'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Database,
  Download,
  FileSpreadsheet,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';

const pages = [
  {
    eyebrow: 'Workflow 01 · Primary Method',
    title: 'Claude Cowork x Apollo (bd-lead-finder)',
    description:
      'Connect Claude Cowork to Apollo using the bd-lead-finder skill to find verified decision-makers (CEOs, CTOs, VPs of Engineering/AI) in target markets like Richmond, VA. Claude validates email formats against strict 3-tier rules and delivers an Excel workbook plus CSV files directly to HELIOS/OUTREACH.',
    prompt:
      'Use bd-lead-finder to build a list of 25 validated decision-maker POCs across top IT & MSP companies in Richmond, VA.',
    downloadSkill: true,
    steps: [
      'Download bd-lead-finder.skill using the button below and install it into your Claude Desktop / Cowork skills folder.',
      'Ensure your Apollo integration is connected in Claude Cowork so Claude can execute Apollo searches.',
      'Ask Claude to build a lead list — specify target companies or vertical, location (e.g. Richmond, VA), and total lead count.',
      'Claude searches Apollo for decision-makers (CEO, CTO, VP Eng, Ops, Innovation), applying strict 3-tier email validation rules.',
      'Claude generates an Excel workbook (.xlsx) and per-company CSV files, saving them directly into your HELIOS/OUTREACH/ folder.',
      'Upload the resulting CSV or Excel sheet to Outreach Hub for enrichment, drafting, and dispatch.',
    ],
    capabilities:
      'Apollo-first verified emails, target decision-maker persona filtering (CEO, CTO, VP, Ops, Innovation), strict 3-tier email validation (verified, verbatim web match, or 95%+ format inferral), automatic delivery to HELIOS/OUTREACH/ as Excel + CSV.',
  },
  {
    eyebrow: 'Workflow 02 · Secondary Method',
    title: 'Using Cowork for Open-Web Research',
    description:
      'Use Claude Cowork when you need to assemble lead lists from public web sources across portfolio companies, conference bios, or press releases. Define your criteria; Cowork researches public sources and structures a clean export.',
    prompt:
      'Map operating partners and tech leads at lower-middle-market healthcare PE firms in the Southeast.',
    downloadSkill: false,
    steps: [
      'Open Claude Cowork and state the exact market, industry, geography, and target roles you want to map.',
      'Provide criteria: industry, geography, company types, target roles, and exclusion rules.',
      'Ask Cowork to research public sources and compile matching contacts with source links.',
      'Review the sources and export the list as a CSV or Excel file.',
      'Upload the file to Outreach Hub for enrichment and drafting.',
    ],
    capabilities:
      'Public web research across leadership teams, portfolio companies, conference bios, and press releases. Outputs CSV, Excel, Word, PDF, or Markdown files.',
  },
] as const;

export function LeadListTutorial() {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
      if (event.key === 'ArrowLeft') setPage((current) => (current + pages.length - 1) % pages.length);
      if (event.key === 'ArrowRight') setPage((current) => (current + 1) % pages.length);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const current = pages[page];
  const previousPage = () => setPage((currentPage) => (currentPage + pages.length - 1) % pages.length);
  const nextPage = () => setPage((currentPage) => (currentPage + 1) % pages.length);

  return (
    <>
      <div
        className="hub-overview__tutorial"
        role="button"
        tabIndex={0}
        onClick={() => {
          setPage(0);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setPage(0);
            setOpen(true);
          }
        }}
      >
        <span className="hub-overview__tutorial-label">Lead-List Playbook</span>
        <strong>Building Lead Lists with Claude & Apollo</strong>
        <span>
          Sourcing verified decision-makers using Claude Cowork x Apollo (
          <code style={{ fontSize: '11px', background: 'var(--color-surface-2)', padding: '2px 5px', borderRadius: '4px' }}>
            bd-lead-finder.skill
          </code>
          ).
        </span>
        <div className="hub-overview__actions">
          <a
            href="/skills/bd-lead-finder.skill"
            download="bd-lead-finder.skill"
            className="hub-skill-dl-btn"
            onClick={(event) => event.stopPropagation()}
          >
            <Download size={14} />
            Download bd-lead-finder.skill
          </a>
          <button
            className="hub-tutorial-trigger"
            type="button"
            tabIndex={-1}
          >
            30 Second Playbook
            <span className="hub-tutorial-trigger__arrow" aria-hidden="true">
              <ArrowRight size={16} />
            </span>
          </button>
        </div>
      </div>

      {open && (
        <div className="tutorial-overlay" role="presentation" onMouseDown={() => setOpen(false)}>
          <div className="tutorial-shell" onMouseDown={(event) => event.stopPropagation()}>
            <button
              className="tutorial-nav tutorial-nav--previous"
              type="button"
              onClick={previousPage}
              aria-label="Previous workflow"
            >
              <ChevronLeft size={22} />
            </button>
            <div
              ref={dialogRef}
              className="tutorial-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="lead-list-tutorial-title"
              tabIndex={-1}
            >
              <header className="tutorial-header">
                <div>
                  <span className="tutorial-header__label">Claude lead-list playbook</span>
                  <span className="tutorial-header__count">
                    {page + 1} of {pages.length}
                  </span>
                </div>
                <button
                  className="tutorial-close"
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close tutorial"
                >
                  <X size={20} />
                </button>
              </header>

              <article className="tutorial-page" key={page}>
                <div className="tutorial-stage">
                  {page === 0 && <CoworkApolloVisual />}
                  {page === 1 && <WebResearchVisual />}
                </div>
                <div className="tutorial-copy">
                  <span className="tutorial-copy__eyebrow">{current.eyebrow}</span>
                  <h2 id="lead-list-tutorial-title">{current.title}</h2>
                  <p className="tutorial-copy__description">{current.description}</p>

                  {current.downloadSkill && (
                    <div className="tutorial-skill-download-box">
                      <div className="tutorial-skill-download-info">
                        <span className="tutorial-skill-badge">bd-lead-finder.skill</span>
                        <strong style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text)' }}>
                          Download Skill for Claude Cowork
                        </strong>
                        <p style={{ margin: 0, fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)' }}>
                          Save to your Claude skills folder & enable Apollo in Cowork.
                        </p>
                      </div>
                      <a
                        href="/skills/bd-lead-finder.skill"
                        download="bd-lead-finder.skill"
                        className="btn btn--primary btn--sm"
                        style={{ display: 'inline-flex', alignItems: 'center', gap: '0.375rem', whiteSpace: 'nowrap' }}
                      >
                        <Download size={14} />
                        Download Skill
                      </a>
                    </div>
                  )}

                  <div className="tutorial-prompt">
                    <span>Example</span>
                    <q>{current.prompt}</q>
                  </div>
                  <div className="tutorial-section">
                    <span className="tutorial-section__label">How it works</span>
                    <ol className="tutorial-lessons">
                      {current.steps.map((step, index) => (
                        <li key={step}>
                          <span>Step {index + 1}</span>
                          <p>{step}</p>
                        </li>
                      ))}
                    </ol>
                  </div>
                  <div className="tutorial-section tutorial-section--capabilities">
                    <span className="tutorial-section__label">Capabilities</span>
                    <p>{current.capabilities}</p>
                  </div>
                </div>
              </article>

              <footer className="tutorial-footer">
                <span className="tutorial-help-signal">
                  <span aria-hidden="true">
                    <ArrowUpRight size={14} />
                  </span>
                  Confused? Screenshot and ask Claude for help!
                </span>
                <div className="tutorial-dots" aria-label="Tutorial pages">
                  {pages.map((item, index) => (
                    <button
                      key={item.eyebrow}
                      className={`tutorial-dot${index === page ? ' tutorial-dot--active' : ''}`}
                      type="button"
                      onClick={() => setPage(index)}
                      aria-label={`Go to workflow ${index + 1}`}
                      aria-current={index === page ? 'step' : undefined}
                    />
                  ))}
                </div>
              </footer>
            </div>
            <button
              className="tutorial-nav tutorial-nav--next"
              type="button"
              onClick={nextPage}
              aria-label="Next workflow"
            >
              <ChevronRight size={22} />
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function CoworkApolloVisual() {
  const stages = [
    { title: 'Apollo Search', sub: 'Richmond IT & MSPs', delay: 100, icon: <Database size={14} /> },
    { title: 'Decision Makers', sub: 'CEO, CTO, VP Eng', delay: 250, icon: <ShieldCheck size={14} /> },
    { title: '3-Tier Email Rules', sub: 'Verified & Inferred', delay: 400, icon: <CheckCircle2 size={14} /> },
    { title: 'HELIOS Delivery', sub: 'Saved to OUTREACH/', delay: 550, icon: <FileSpreadsheet size={14} /> },
  ];

  return (
    <div className="tutorial-visual tutorial-visual--apollo" aria-hidden="true">
      <div className="tutorial-cowork">
        <div className="tutorial-cowork__header">
          <span className="tutorial-query__mark">C</span>
          <div>
            <strong>Claude Cowork</strong>
            <div style={{ display: 'flex', gap: '0.375rem', alignItems: 'center', marginTop: '2px', flexWrap: 'wrap' }}>
              <span className="tutorial-cowork__badge">bd-lead-finder.skill</span>
              <span className="tutorial-cowork__badge tutorial-cowork__badge--apollo">
                Apollo Connected
              </span>
            </div>
          </div>
          <i />
        </div>
        <div className="tutorial-cowork__messages">
          <div className="tutorial-chat tutorial-chat--user">
            Use bd-lead-finder to build a list of 25 POCs across top IT & MSP firms in Richmond, VA.
          </div>
          <div className="tutorial-chat tutorial-chat--claude">
            <span className="tutorial-chat__spark">
              <Sparkles size={14} />
            </span>
            Sourcing via Apollo... 25 verified decision-maker POCs compiled with 100% valid emails.
          </div>
        </div>
      </div>

      <div className="tutorial-apollo-pipeline">
        {stages.map((stage) => (
          <div
            key={stage.title}
            className="tutorial-apollo-stage"
            style={{ animationDelay: `${stage.delay}ms` }}
          >
            <div style={{ color: 'var(--color-primary)', display: 'flex', alignItems: 'center' }}>
              {stage.icon}
            </div>
            <strong>{stage.title}</strong>
            <span>{stage.sub}</span>
          </div>
        ))}
      </div>

      <div className="tutorial-web-output" style={{ animationDelay: '700ms' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
          <span>DELIVERABLE</span>
          <small style={{ color: 'var(--color-positive)', fontWeight: 'bold' }}>✓ HELIOS/OUTREACH/</small>
        </div>
        <strong>Richmond_IT_MSP_Leads.xlsx</strong>
        <small>25 Verified POCs • Excel Workbook + CSVs</small>
      </div>
    </div>
  );
}

function WebResearchVisual() {
  const sources = ['Portfolio pages', 'Conference bios', 'Trade associations'];
  return (
    <div className="tutorial-visual tutorial-visual--web" aria-hidden="true">
      <div className="tutorial-cowork">
        <div className="tutorial-cowork__header">
          <span className="tutorial-query__mark">C</span>
          <div>
            <strong>Claude Cowork</strong>
            <span>New lead-list research</span>
          </div>
          <i />
        </div>
        <div className="tutorial-cowork__messages">
          <div className="tutorial-chat tutorial-chat--user">
            Find operating partners at healthcare PE firms in the Southeast.
          </div>
          <div className="tutorial-chat tutorial-chat--claude">
            <span className="tutorial-chat__spark">
              <Sparkles size={14} />
            </span>
            I’ll research public sources and organize the results.
          </div>
        </div>
      </div>
      <div className="tutorial-web-flow">
        <div className="tutorial-web-sources">
          <span className="tutorial-web-sources__label">Claude checks public sources</span>
          <div className="tutorial-source-grid">
            {sources.map((source, index) => (
              <div className="tutorial-source" key={source} style={{ animationDelay: `${index * 140}ms` }}>
                <span>{String(index + 1).padStart(2, '0')}</span>
                <strong>{source}</strong>
                <i />
              </div>
            ))}
          </div>
        </div>
        <span className="tutorial-web-flow__arrow">
          <ArrowRight size={20} />
        </span>
        <div className="tutorial-web-output">
          <span>LEAD LIST</span>
          <strong>Healthcare PE operating partners</strong>
          <small>Names · titles · firms · sources</small>
        </div>
      </div>
      <div className="tutorial-file-flow">
        <span>Export in the format you need</span>
        <div>
          {['CSV', 'XLSX', 'DOCX', 'PDF', 'MD'].map((type) => (
            <b key={type}>{type}</b>
          ))}
        </div>
      </div>
    </div>
  );
}
