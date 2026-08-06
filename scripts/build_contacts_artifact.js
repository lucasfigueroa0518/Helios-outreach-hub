const fs = require('fs');
const path = require('path');

const data = fs.readFileSync(path.join(__dirname, 'contacts_view.json'), 'utf8')
  .replace(/�/g, '')     // drop invalid-byte replacement chars the deploy rejects
  .replace(/</g, '\\u003c');  // safe to embed inside <script type=application/json>

const html = `<style>
  :root{
    --ground:#F6F7F9; --panel:#FFFFFF; --ink:#14171C; --muted:#616B7A;
    --faint:#8A93A0; --hair:#E4E8ED; --hair-strong:#D4DAE1;
    --accent:#0B6E6B; --accent-soft:#E1EFEE; --bar:#12161C;
    --row-hover:#F0F5F5; --pill:#EEF1F4;
    --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
    --sans:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  }
  *{box-sizing:border-box}
  .wrap{font-family:var(--sans);color:var(--ink);background:var(--ground);min-height:100vh;
    display:flex;flex-direction:column;font-size:13px;line-height:1.45}
  .topbar{background:var(--bar);color:#fff;padding:18px 22px;display:flex;align-items:baseline;
    justify-content:space-between;flex-wrap:wrap;gap:10px}
  .topbar h1{margin:0;font-size:18px;font-weight:650;letter-spacing:-.01em}
  .topbar .meta{font-size:12px;color:#AEB7C2}
  .topbar .meta b{color:#fff;font-variant-numeric:tabular-nums;font-weight:600}
  .src{font-size:11px;color:#8892A0;margin-top:2px;letter-spacing:.02em}
  .toolbar{display:flex;align-items:center;gap:14px;padding:12px 22px;background:var(--panel);
    border-bottom:1px solid var(--hair);flex-wrap:wrap;position:sticky;top:0;z-index:5}
  .search{flex:1;min-width:220px;position:relative}
  .search input{width:100%;padding:9px 12px 9px 34px;border:1px solid var(--hair-strong);
    border-radius:7px;font-size:13px;font-family:var(--sans);color:var(--ink);background:#fff;outline:none}
  .search input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
  .search svg{position:absolute;left:11px;top:50%;transform:translateY(-50%);color:var(--faint)}
  .count{font-size:12px;color:var(--muted);white-space:nowrap;font-variant-numeric:tabular-nums}
  .count b{color:var(--ink);font-weight:650}
  .tablewrap{flex:1;overflow:auto;background:var(--panel)}
  table{border-collapse:separate;border-spacing:0;width:100%;min-width:1180px}
  thead th{position:sticky;top:0;background:#FBFCFD;text-align:left;font-size:11px;
    font-weight:650;letter-spacing:.03em;text-transform:uppercase;color:var(--muted);
    padding:10px 14px;border-bottom:1px solid var(--hair-strong);cursor:pointer;
    white-space:nowrap;user-select:none}
  thead th:hover{color:var(--accent)}
  thead th .arw{color:var(--accent);font-size:10px;margin-left:4px}
  tbody td{padding:9px 14px;border-bottom:1px solid var(--hair);vertical-align:top;
    max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  tbody tr:hover td{background:var(--row-hover)}
  td.name{font-weight:600;color:var(--ink)}
  td.mono{font-family:var(--mono);font-size:12px;color:var(--muted)}
  td.email a{color:var(--accent);text-decoration:none}
  td.email a:hover{text-decoration:underline}
  .dim{color:var(--faint)}
  .pill{display:inline-block;padding:2px 8px;border-radius:999px;background:var(--pill);
    color:#4A5563;font-size:11px;font-weight:600;white-space:nowrap}
  .foot{display:flex;align-items:center;justify-content:space-between;gap:12px;
    padding:11px 22px;background:var(--panel);border-top:1px solid var(--hair);flex-wrap:wrap}
  .pager{display:flex;align-items:center;gap:8px}
  .pager button{font-family:var(--sans);font-size:12px;padding:6px 12px;border:1px solid var(--hair-strong);
    background:#fff;border-radius:6px;color:var(--ink);cursor:pointer}
  .pager button:hover:not(:disabled){border-color:var(--accent);color:var(--accent)}
  .pager button:disabled{opacity:.4;cursor:not-allowed}
  .pager .pos{font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
  .empty{padding:60px 22px;text-align:center;color:var(--muted)}
  :focus-visible{outline:2px solid var(--accent);outline-offset:2px}
</style>

<div class="wrap">
  <div class="topbar">
    <div>
      <h1>Contacts</h1>
      <div class="src">Salesforce contact export &middot; pe-relationships-sf &middot; 2026-07-10</div>
    </div>
    <div class="meta"><b id="total">0</b> contacts &middot; <b id="companies">0</b> companies &middot; <b id="withemail">0</b> with email</div>
  </div>

  <div class="toolbar">
    <div class="search">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/></svg>
      <input id="q" type="search" placeholder="Search name, company, title, or email…" autocomplete="off" spellcheck="false"/>
    </div>
    <div class="count"><b id="shown">0</b> matching</div>
  </div>

  <div class="tablewrap">
    <table>
      <thead><tr id="head"></tr></thead>
      <tbody id="body"></tbody>
    </table>
    <div id="empty" class="empty" hidden>No contacts match your search.</div>
  </div>

  <div class="foot">
    <div class="pager">
      <button id="prev">Previous</button>
      <span class="pos" id="pos">—</span>
      <button id="next">Next</button>
    </div>
    <div class="count">Showing <b id="range">0</b> of <b id="shownf">0</b></div>
  </div>
</div>

<script id="data" type="application/json">${data}</script>
<script>
  const DB = JSON.parse(document.getElementById('data').textContent);
  const H = DB.headers, ALL = DB.rows;
  const PER = 50;
  const MONO = new Set([3,4,11]);      // Email, Phone, SF ID
  const NAMEC = 0, EMAILC = 3, STATUSC = 10;
  let filtered = ALL, page = 0, sortCol = 0, sortDir = 1;

  const esc = s => (s==null?'':String(s)).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const $ = id => document.getElementById(id);

  // stats
  $('total').textContent = ALL.length.toLocaleString();
  $('companies').textContent = new Set(ALL.map(r=>r[2]).filter(Boolean)).size.toLocaleString();
  $('withemail').textContent = ALL.filter(r=>r[EMAILC]).length.toLocaleString();

  // header
  $('head').innerHTML = H.map((h,i)=>\`<th data-c="\${i}">\${esc(h)}<span class="arw" data-arw="\${i}"></span></th>\`).join('');
  document.querySelectorAll('#head th').forEach(th=>{
    th.addEventListener('click',()=>{
      const c = +th.dataset.c;
      if (c===sortCol) sortDir*=-1; else { sortCol=c; sortDir=1; }
      apply();
    });
  });

  function apply(){
    const q = $('q').value.trim().toLowerCase();
    filtered = q ? ALL.filter(r =>
      (r[0]+' '+r[1]+' '+r[2]+' '+r[3]).toLowerCase().includes(q)
    ) : ALL;
    filtered = filtered.slice().sort((a,b)=>{
      const x=(a[sortCol]||'').toLowerCase(), y=(b[sortCol]||'').toLowerCase();
      return x<y?-1*sortDir : x>y?1*sortDir : 0;
    });
    page = 0;
    document.querySelectorAll('[data-arw]').forEach(s=>s.textContent='');
    document.querySelector('[data-arw="'+sortCol+'"]').textContent = sortDir>0?'▲':'▼';
    render();
  }

  function render(){
    const n = filtered.length;
    const pages = Math.max(1, Math.ceil(n/PER));
    if (page>=pages) page=pages-1;
    const start = page*PER, end = Math.min(start+PER, n);
    const slice = filtered.slice(start, end);

    $('shown').textContent = n.toLocaleString();
    $('shownf').textContent = n.toLocaleString();
    $('range').textContent = n? (start+1).toLocaleString()+'–'+end.toLocaleString() : '0';
    $('pos').textContent = 'Page '+(page+1)+' of '+pages;
    $('prev').disabled = page===0;
    $('next').disabled = page>=pages-1;
    $('empty').hidden = n>0;

    $('body').innerHTML = slice.map(r=>'<tr>'+r.map((v,i)=>{
      let cls = i===NAMEC?'name':MONO.has(i)?'mono':'';
      if (!v) return '<td class="'+cls+'"><span class="dim">—</span></td>';
      if (i===EMAILC) return '<td class="email mono"><a href="mailto:'+esc(v)+'">'+esc(v)+'</a></td>';
      if (i===STATUSC) return '<td><span class="pill">'+esc(v)+'</span></td>';
      return '<td class="'+cls+'" title="'+esc(v)+'">'+esc(v)+'</td>';
    }).join('')+'</tr>').join('');
  }

  let deb;
  $('q').addEventListener('input',()=>{clearTimeout(deb);deb=setTimeout(apply,140);});
  $('prev').addEventListener('click',()=>{if(page>0){page--;render();document.querySelector('.tablewrap').scrollTop=0;}});
  $('next').addEventListener('click',()=>{page++;render();document.querySelector('.tablewrap').scrollTop=0;});

  apply();
</script>`;

fs.writeFileSync(path.join(__dirname, '..', 'contacts_viewer.html'), html);
console.log('wrote contacts_viewer.html', Math.round(Buffer.byteLength(html)/1024), 'KB');
