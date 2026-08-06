'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, ChevronLeft, ChevronRight, MousePointer2, Sparkles, X } from 'lucide-react';

const pages = [
  {
    eyebrow: 'Workflow 01 · Sales Navigator',
    title: 'Claude in Chrome x Linkedin Sales Navigator',
    description: 'Use Claude Cowork to describe your ideal lead. Claude in Chrome can then work through the Sales Navigator search controls in your supervised browser session and organize the visible results into a lead-list document.',
    prompt: 'Find CFOs and finance leaders at PE-backed healthcare companies in Texas.',
    steps: [
      'Install Claude in Chrome and sign in with your approved Claude account.',
      'Open LinkedIn Sales Navigator in Chrome and sign in to your existing account.',
      'Open Claude Cowork and explain the people you want to find: roles, companies, market, geography, and exclusions.',
      'Ask Claude to use Sales Navigator to build the search; watch it apply the filters in your browser.',
      'Review the resulting lead list, refine the search if needed, and ask Claude to create a document containing the leads.',
      'Upload that document to Outreach Hub for enrichment.',
    ],
    capabilities: 'Filter by current or past company, headquarters, job title, seniority, geography, industry, company size, and more. Export the resulting list as CSV, Excel, Word, or another convenient file type.',
  },
  {
    eyebrow: 'Workflow 02 · Open-web research',
    title: 'Using cowork to search the web.',
    description: 'Use Claude Cowork when the list needs to be assembled from public information across the web. Define the market, people, and signals you need; Cowork can research and structure the findings into a usable lead list.',
    prompt: 'Map operating partners at lower-middle-market healthcare PE firms in the Southeast.',
    steps: [
      'Open Claude Cowork and state the exact market you want to map.',
      'Give it the criteria: industry, geography, company types, target roles, and any exclusion rules.',
      'Ask it to research public sources and compile only people who match those criteria.',
      'Ask for the fields you need in the list, such as name, title, company, location, source link, and public email where available.',
      'Review the list and source links, then ask Claude to export it as a CSV, Excel file, Word document, PDF, Markdown file, or plain text.',
      'Upload the finished file to Outreach Hub for enrichment and Embark relationship context.',
    ],
    capabilities: 'Research leadership teams, portfolio companies, associations, conference speakers, filings, and news. It can collect public contact details where available and produce CSV, Excel, Word, PDF, Markdown, or plain-text output.',
  },
  {
    eyebrow: 'Workflow 03 · Salesforce reactivation',
    title: 'Using Claude in Chrome to search salesforce.',
    description: 'Use Claude in Chrome within your authorized Salesforce session to identify old or inactive relationships that may be worth revisiting, then turn the reviewed records into a reactivation list.',
    prompt: 'Find finance leaders with no Embark activity in the last 12 months at active target accounts.',
    steps: [
      'Install Claude in Chrome and sign in with your approved Claude account.',
      'Open Salesforce in Chrome and sign in using your authorized Embark access.',
      'Open Claude Cowork and describe the relationships you want to revisit, including the inactivity window.',
      'Ask Claude to build the Salesforce search using fields such as last activity, account, title, owner, opportunity history, industry, or geography.',
      'Review the contacts and accounts Claude surfaces; remove any relationships that are not appropriate to re-engage.',
      'Ask Claude to compile the approved records and relevant context into a lead-list document, then upload it to Outreach Hub.',
    ],
    capabilities: 'Find dormant contacts or accounts, segment by Salesforce fields, and surface opportunity history or relationship context. Work only in your authorized Salesforce session and review exports before sharing them.',
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
        <span className="hub-overview__tutorial-label">Not sure where to start?</span>
        <strong>Building Good Lead Lists with Claude</strong>
        <span>Three practical workflows for finding the right people FAST.</span>
        <button
          className="hub-tutorial-trigger"
          type="button"
          tabIndex={-1}
        >
          30 Second Learning
          <span className="hub-tutorial-trigger__arrow" aria-hidden="true"><ArrowRight size={16} /></span>
        </button>
      </div>

      {open && (
        <div className="tutorial-overlay" role="presentation" onMouseDown={() => setOpen(false)}>
          <div className="tutorial-shell" onMouseDown={(event) => event.stopPropagation()}>
            <button className="tutorial-nav tutorial-nav--previous" type="button" onClick={previousPage} aria-label="Previous workflow"><ChevronLeft size={22} /></button>
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
                  <span className="tutorial-header__count">{page + 1} of {pages.length}</span>
                </div>
                <button className="tutorial-close" type="button" onClick={() => setOpen(false)} aria-label="Close tutorial"><X size={20} /></button>
              </header>

              <article className="tutorial-page" key={page}>
                <div className="tutorial-stage">
                  {page === 0 && <SalesNavigatorVisual />}
                  {page === 1 && <WebResearchVisual />}
                  {page === 2 && <SalesforceVisual />}
                </div>
                <div className="tutorial-copy">
                  <span className="tutorial-copy__eyebrow">{current.eyebrow}</span>
                  <h2 id="lead-list-tutorial-title">{current.title}</h2>
                  <p className="tutorial-copy__description">{current.description}</p>
                  <div className="tutorial-prompt">
                    <span>Example</span>
                    <q>{current.prompt}</q>
                  </div>
                  <div className="tutorial-section">
                    <span className="tutorial-section__label">How it works</span>
                    <ol className="tutorial-lessons">
                    {current.steps.map((step, index) => (
                      <li key={step}><span>Step {index + 1}</span><p>{step}</p></li>
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
                  <span aria-hidden="true"><ArrowUpRight size={14} /></span>
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
            <button className="tutorial-nav tutorial-nav--next" type="button" onClick={nextPage} aria-label="Next workflow"><ChevronRight size={22} /></button>
          </div>
        </div>
      )}
    </>
  );
}

function BrowserTop({ address }: { address: string }) {
  return (
    <div className="tutorial-browser__top">
      <div className="tutorial-browser__controls" aria-hidden="true"><span /><span /><span /></div>
      <span className="tutorial-browser__address">{address}</span>
    </div>
  );
}

function SalesNavigatorVisual() {
  const filters = ['Current company', 'Job title', 'Seniority', 'Geography', 'Past company'];
  return (
    <div className="tutorial-visual tutorial-visual--navigator" aria-hidden="true">
      <div className="tutorial-browser">
        <BrowserTop address="linkedin.com/sales/search/people" />
        <div className="tutorial-browser__body">
          <div className="tutorial-filter-rail">
            <strong>Lead filters</strong>
            {filters.map((filter, index) => (
              <span key={filter} style={{ animationDelay: `${index * 120}ms` }}>{filter}<b>+</b></span>
            ))}
          </div>
          <div className="tutorial-results">
            <div className="tutorial-results__heading"><span>Search results</span><strong>127 leads</strong></div>
            {['AM', 'JR', 'SK'].map((initials, index) => (
              <div className="tutorial-person" key={initials} style={{ animationDelay: `${index * 160 + 300}ms` }}>
                <span>{initials}</span><div><b /><i /></div><em>Save</em>
              </div>
            ))}
          </div>
        </div>
        <span className="tutorial-cursor"><MousePointer2 size={28} /></span>
      </div>
      <div className="tutorial-output-file">
        <span>DOCX</span>
        <div><strong>Texas finance leaders</strong><small>127 organized leads</small></div>
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
          <div><strong>Claude Cowork</strong><span>New lead-list research</span></div>
          <i />
        </div>
        <div className="tutorial-cowork__messages">
          <div className="tutorial-chat tutorial-chat--user">
            Find operating partners at healthcare PE firms in the Southeast.
          </div>
          <div className="tutorial-chat tutorial-chat--claude">
            <span className="tutorial-chat__spark"><Sparkles size={14} /></span>
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
                <span>{String(index + 1).padStart(2, '0')}</span><strong>{source}</strong><i />
              </div>
            ))}
          </div>
        </div>
        <span className="tutorial-web-flow__arrow"><ArrowRight size={20} /></span>
        <div className="tutorial-web-output">
          <span>LEAD LIST</span>
          <strong>Healthcare PE operating partners</strong>
          <small>Names · titles · firms · sources</small>
        </div>
      </div>
      <div className="tutorial-file-flow">
        <span>Export in the format you need</span>
        <div>{['CSV', 'XLSX', 'DOCX', 'PDF', 'MD'].map((type) => <b key={type}>{type}</b>)}</div>
      </div>
    </div>
  );
}

function SalesforceVisual() {
  const rows = [
    { initials: 'TR', name: 'Taylor Reed', activity: '2 months ago', stale: false },
    { initials: 'MP', name: 'Morgan Patel', activity: '8 months ago', stale: true },
    { initials: 'AL', name: 'Alex Lee', activity: '14 months ago', stale: true },
  ];
  return (
    <div className="tutorial-visual tutorial-visual--salesforce" aria-hidden="true">
      <div className="tutorial-browser tutorial-browser--salesforce">
        <BrowserTop address="embark.lightning.force.com" />
        <div className="tutorial-salesforce-toolbar">
          <strong>Dormant relationships</strong>
          <span>Last activity &gt; 6 months</span>
        </div>
        <div className="tutorial-salesforce-list">
          {rows.map((row, index) => (
            <div className={`tutorial-salesforce-row${row.stale ? ' tutorial-salesforce-row--match' : ''}`} key={row.name} style={{ animationDelay: `${index * 180}ms` }}>
              <span>{row.initials}</span>
              <div><strong>{row.name}</strong><small>Finance leader · Target account</small></div>
              <time>{row.activity}</time>
            </div>
          ))}
        </div>
        <div className="tutorial-chrome-assistant">
          <div className="tutorial-chrome-assistant__header">
            <span>C</span>
            <strong>Claude in Chrome</strong>
          </div>
          <p>Filtering activity older than 6 months…</p>
          <div><i /><i /><i /></div>
        </div>
      </div>
      <div className="tutorial-reactivation">
        <span>2</span>
        <div><strong>relationships ready to revisit</strong><small>Reviewed and organized by inactivity</small></div>
      </div>
    </div>
  );
}
