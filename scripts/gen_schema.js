const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'pe-relationships-sf', 'output');
const OUT_DIR = path.join(__dirname, '..', 'db');

const files = [
  { file: 'pe-relationships-sf--accounts_20260710.csv', table: 'accounts' },
  { file: 'pe-relationships-sf--call-participants_20260710.csv', table: 'call_participants' },
  { file: 'pe-relationships-sf--contacts_20260710.csv', table: 'contacts' },
  { file: 'pe-relationships-sf--opportunities_20260710.csv', table: 'opportunities' },
  { file: 'pe-relationships-sf--pitchbook-firms_20260710.csv', table: 'pitchbook_firms' },
  { file: 'pe-relationships-sf--pitchbook-sister-cos_20260710.csv', table: 'pitchbook_sister_cos' },
];

// RFC4180-ish CSV parser
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      } else { field += c; i++; continue; }
    } else {
      if (c === '"') { inQuotes = true; i++; continue; }
      if (c === ',') { row.push(field); field = ''; i++; continue; }
      if (c === '\r') { i++; continue; }
      if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
      field += c; i++; continue;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function toSnake(name) {
  return name
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/__+/g, '_')
    .toLowerCase();
}

function inferType(values) {
  let allInt = true, allNumeric = true, allBool = true, allDate = true, allTs = true;
  let any = false;
  let maxLen = 0;
  for (const v of values) {
    if (v === '' || v == null) continue;
    any = true;
    maxLen = Math.max(maxLen, v.length);
    if (allBool && !/^(true|false)$/i.test(v)) allBool = false;
    if (allInt && !/^-?\d+$/.test(v)) allInt = false;
    if (allNumeric && !/^-?\d+(\.\d+)?$/.test(v)) allNumeric = false;
    if (allDate && !/^\d{4}-\d{2}-\d{2}$/.test(v)) allDate = false;
    if (allTs && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?$/.test(v)) allTs = false;
  }
  if (!any) return 'text';
  if (allBool) return 'boolean';
  if (allTs) return 'timestamptz';
  if (allDate) return 'date';
  if (allInt) {
    // check overflow for bigint vs int
    return 'bigint';
  }
  if (allNumeric) return 'numeric';
  return maxLen > 1000 ? 'text' : 'text';
}

let ddl = '';
let copyCmds = '';

for (const { file, table } of files) {
  const filePath = path.join(DATA_DIR, file);
  const text = fs.readFileSync(filePath, 'utf8');
  const rows = parseCSV(text);
  const header = rows[0];
  const dataRows = rows.slice(1).filter(r => r.length === header.length);
  const cols = header.map((h, idx) => {
    const values = dataRows.map(r => r[idx]);
    const type = inferType(values);
    return { name: toSnake(h), type };
  });

  // dedupe column names (case-insensitive) that collide, e.g. SF_ID vs sf_id
  const seen = new Map();
  cols.forEach(c => {
    const key = c.name.toLowerCase();
    if (seen.has(key)) {
      let n = 2;
      let newName = `${c.name}_${n}`;
      while (seen.has(newName.toLowerCase())) { n++; newName = `${c.name}_${n}`; }
      c.name = newName;
    }
    seen.set(c.name.toLowerCase(), true);
  });

  ddl += `DROP TABLE IF EXISTS ${table};\n`;
  ddl += `CREATE TABLE ${table} (\n`;
  ddl += cols.map(c => `    "${c.name}" ${c.type}`).join(',\n');
  ddl += `\n);\n\n`;

  const relPath = path.relative(path.join(__dirname, '..'), filePath).replace(/\\/g, '/');
  copyCmds += `\\copy ${table} (${cols.map(c => `"${c.name}"`).join(', ')}) FROM '${relPath}' WITH (FORMAT csv, HEADER true, ENCODING 'UTF8');\n`;
}

fs.writeFileSync(path.join(OUT_DIR, 'schema.sql'), ddl);
fs.writeFileSync(path.join(OUT_DIR, 'load_data.sql'), copyCmds);
console.log('Done. Wrote db/schema.sql and db/load_data.sql');
