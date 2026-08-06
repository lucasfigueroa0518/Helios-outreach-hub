const fs = require('fs');
const path = require('path');

function parseCSV(text) {
  const rows = []; let row = [], field = '', inQ = false, i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQ) { if (c === '"') { if (text[i+1] === '"') { field+='"'; i+=2; continue; } inQ=false; i++; continue; } field += c; i++; continue; }
    else {
      if (c === '"') { inQ=true; i++; continue; }
      if (c === ',') { row.push(field); field=''; i++; continue; }
      if (c === '\r') { i++; continue; }
      if (c === '\n') { row.push(field); rows.push(row); row=[]; field=''; i++; continue; }
      field += c; i++; continue;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const DIR = path.join(__dirname, '..', 'pe-relationships-sf', 'output');
const raw = parseCSV(fs.readFileSync(path.join(DIR, 'pe-relationships-sf--contacts_20260710.csv'), 'utf8'));
const h = raw[0];
const idx = (c) => h.indexOf(c);
const data = raw.slice(1).filter(r => r.length === h.length);

const cols = {
  id: idx('id'), first: idx('first_name'), last: idx('last_name'), title: idx('title'),
  company: idx('account_name'), email: idx('email'), phone: idx('phone'), mobile: idx('mobile_phone'),
  city: idx('mailing_city'), state: idx('mailing_state'), dept: idx('department'),
  lead: idx('lead_source'), owner: idx('owner_name'), status: idx('contact_status_c'),
  deleted: idx('is_deleted'),
};

const HEADERS = ['Name','Title','Company','Email','Phone','City','State','Department','Lead Source','Owner','Status','SF ID'];
const out = [];
for (const r of data) {
  if (r[cols.deleted] === 'true') continue;
  const name = [r[cols.first], r[cols.last]].filter(Boolean).join(' ').trim();
  const phone = (r[cols.phone] || r[cols.mobile] || '').trim();
  out.push([
    name, r[cols.title]||'', r[cols.company]||'', r[cols.email]||'', phone,
    r[cols.city]||'', r[cols.state]||'', r[cols.dept]||'', r[cols.lead]||'',
    r[cols.owner]||'', r[cols.status]||'', r[cols.id]||''
  ]);
}
out.sort((a,b) => (a[0]||'').localeCompare(b[0]||''));

fs.writeFileSync(path.join(__dirname, 'contacts_view.json'), JSON.stringify({ headers: HEADERS, rows: out }));
console.log('rows:', out.length);
console.log('with email:', out.filter(r=>r[3]).length);
console.log('distinct companies:', new Set(out.map(r=>r[2]).filter(Boolean)).size);
const bytes = fs.statSync(path.join(__dirname, 'contacts_view.json')).size;
console.log('json size KB:', Math.round(bytes/1024));
