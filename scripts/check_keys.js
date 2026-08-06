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
function load(f){ const r=parseCSV(fs.readFileSync(path.join(DIR,f),'utf8')); return {h:r[0], d:r.slice(1).filter(x=>x.length===r[0].length)}; }

function checkKey(file, cols) {
  const { h, d } = load(file);
  const idxs = cols.map(c => h.indexOf(c));
  if (idxs.some(i => i < 0)) return `  ${file} [${cols}]: COLUMN MISSING (have ${cols.map((c,k)=>c+'='+idxs[k])})`;
  const seen = new Map(); let dups = 0, nulls = 0, dupEx = null;
  for (const r of d) {
    const key = idxs.map(i => r[i]).join('');
    if (idxs.some(i => !r[i] || r[i].trim()==='')) nulls++;
    if (seen.has(key)) { dups++; if(!dupEx) dupEx = idxs.map(i=>r[i]).join(' | '); }
    else seen.set(key, 1);
  }
  return `  ${file} [${cols.join(', ')}]: rows=${d.length} distinct=${seen.size} dups=${dups} nulls=${nulls}` + (dupEx?`  e.g.dup="${dupEx}"`:'');
}

console.log('KEY UNIQUENESS CHECK (proposed PK/UNIQUE per plan):');
console.log(checkKey('pe-relationships-sf--contacts_20260710.csv', ['id']));
console.log(checkKey('pe-relationships-sf--accounts_20260710.csv', ['id']));
console.log(checkKey('pe-relationships-sf--opportunities_20260710.csv', ['id']));
console.log(checkKey('pe-relationships-sf--call-participants_20260710.csv', ['meeting_id','participant_seq']));
console.log(checkKey('pe-relationships-sf--pitchbook-firms_20260710.csv', ['CompanyID','RowID']));
console.log(checkKey('pe-relationships-sf--pitchbook-sister-cos_20260710.csv', ['CompanyID','InvestorID','RowID']));
