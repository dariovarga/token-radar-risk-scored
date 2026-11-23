// Token Radar, risk-scored edition — the board. No network: data arrives as
// window.RADAR from ../data.js, written by main.ts from the same board.json.
// State lives in the URL hash, so the board, a detail view and a filtered view
// are each a link: #detail=<slug>, #risk=<grade>, #cat=<category>,
// #chain=<chain>, #q=<text>, #sort=<key>, #watch=1.

const D = window.RADAR;
const $ = (id) => document.getElementById(id);
const rowsEl = $('rows');
const fmt$ = (n) => '$' + Math.round(n).toLocaleString('en-US');
const fmtInt = (n) => Math.round(n).toLocaleString('en-US');
const fmtPct = (n) => (n === null || n === undefined ? '—' : (n > 0 ? '+' : '') + n.toFixed(1) + '%');
const fmtAge = (n) => (n === null || n === undefined ? '—' : n >= 365 ? (n / 365).toFixed(1) + 'y' : n + 'd');
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function hashState() {
  const out = {};
  for (const part of location.hash.slice(1).split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[decodeURIComponent(part.slice(0, i))] = decodeURIComponent(part.slice(i + 1));
  }
  return out;
}

function writeHash(state) {
  const parts = [];
  for (const [k, v] of Object.entries(state)) {
    if (v !== '' && v !== undefined && v !== null) parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
  }
  history.replaceState(null, '', parts.length ? '#' + parts.join('&') : location.pathname + location.search);
}

const SORTS = {
  adj: (a, b) => b.implied_value_usd - a.implied_value_usd,
  raw: (a, b) => b.raw_implied_value_usd - a.raw_implied_value_usd,
  tvl: (a, b) => b.tvl_usd - a.tvl_usd,
  growth: (a, b) => (b.change_7d ?? -1e9) - (a.change_7d ?? -1e9),
  'risk-asc': (a, b) => a.risk_score - b.risk_score,
  'risk-desc': (a, b) => b.risk_score - a.risk_score,
  age: (a, b) => (b.age_days ?? -1) - (a.age_days ?? -1),
};

let state = { q: '', cat: '', chain: '', risk: '', sort: 'adj', watch: false, detail: '' };

function readState() {
  const h = hashState();
  state = {
    q: h.q || '',
    cat: h.cat || '',
    chain: h.chain || '',
    risk: h.risk || '',
    sort: SORTS[h.sort] ? h.sort : 'adj',
    watch: h.watch === '1',
    detail: h.detail || '',
  };
}

function pushState() {
  writeHash({
    q: state.q,
    cat: state.cat,
    chain: state.chain,
    risk: state.risk,
    sort: state.sort === 'adj' ? '' : state.sort,
    watch: state.watch ? '1' : '',
    detail: state.detail,
  });
}

function filteredRows() {
  const q = state.q.trim().toLowerCase();
  const list = D.rows.filter((r) => {
    if (state.watch && !D.watchlist.includes(r.slug)) return false;
    if (state.cat && r.category !== state.cat) return false;
    if (state.chain && !r.chains.includes(state.chain)) return false;
    if (state.risk && r.risk_grade !== state.risk) return false;
    if (q && !(r.name.toLowerCase().includes(q) || r.slug.toLowerCase().includes(q))) return false;
    return true;
  });
  list.sort(SORTS[state.sort] || SORTS.adj);
  return list;
}

function riskCell(r) {
  return `<span class="pill ${esc(r.risk_grade)}">${esc(r.risk_grade)}</span><span class="risknum">${r.risk_score}/100 ${esc(r.risk_label)}</span>`;
}

function renderBoard() {
  const list = filteredRows();
  rowsEl.innerHTML = list
    .map(
      (r) => `<tr data-slug="${esc(r.slug)}" class="${state.detail === r.slug ? 'sel' : ''}">
      <td>${r.rank}</td>
      <td><span class="name">${esc(r.name)}</span><span class="slug">${esc(r.slug)}</span></td>
      <td>${esc(r.category || '—')}</td>
      <td>${r.chains.slice(0, 3).map(esc).join(', ')}${r.chains.length > 3 ? ' +' + (r.chains.length - 3) : ''}</td>
      <td class="num">${fmt$(r.tvl_usd)}</td>
      <td class="num">${fmtPct(r.change_7d)}</td>
      <td class="num">${fmtAge(r.age_days)}</td>
      <td class="num">${fmt$(r.raw_implied_value_usd)}</td>
      <td>${riskCell(r)}</td>
      <td class="num adj">${fmt$(r.implied_value_usd)}</td>
    </tr>`,
    )
    .join('');
  $('count').textContent = `Showing ${list.length} of ${D.rows.length} ranked protocols` +
    (state.sort !== 'adj' ? ` — sorted by ${$('sort').selectedOptions[0].textContent.replace('Sort: ', '')}` : '') +
    `. Click a row for its risk breakdown and farm plan.`;
}


// --- Farm plans, generated in the page from the row's own record. ---
// This is the same plan main.ts writes into board.json (lib/risk.ts):
// six steps, each with a cost and a time, the position sized to the risk grade.

function capitalFor(row) {
  let base;
  if (row.tvl_usd >= 5e9) base = 250;
  else if (row.tvl_usd >= 1e9) base = 150;
  else if (row.tvl_usd >= 1e8) base = 100;
  else base = 50;
  const cut = { A: 1, B: 1, C: 0.6, D: 0.4, E: 0.25, F: 0.25 };
  return Math.max(25, Math.round((base * (cut[row.risk_grade] ?? 1)) / 5) * 5);
}

function holdDaysFor(age) {
  if (age === null || age === undefined) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

function actionFor(row, capital) {
  const c = (row.category || '').toLowerCase();
  const chain = row.chains.length ? row.chains[0] : 'its main chain';
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral'))
    return `Lend $${capital} of USDC on ${row.name} (${chain}) and leave the supply earning.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm'))
    return `Add $${capital} of liquidity to ${row.name}'s deepest pool on ${chain} and keep it in range.`;
  if (c.includes('perpetual') || c.includes('derivative'))
    return `Post $${capital} of USDC as margin on ${row.name} and open one small hedged position.`;
  if (c.includes('prediction'))
    return `Fund $${capital} on ${row.name} and take one position in an active market.`;
  if (c.includes('curator') || c.includes('allocator'))
    return `Deposit $${capital} into a ${row.name} vault on ${chain} and hold the vault shares.`;
  if (c.includes('stable'))
    return `Mint or deposit $${capital} of the stable asset through ${row.name} on ${chain}.`;
  if (c.includes('rwa'))
    return `Mint $${capital} of ${row.name}'s yield-bearing asset on ${chain} and hold it.`;
  if (c.includes('insurance'))
    return `Buy $${capital} of cover from ${row.name} on ${chain} and keep the policy live.`;
  return `Deposit $${capital} of USDC into ${row.name} on ${chain} and keep the position open.`;
}

function farmPlan(row) {
  const capital = capitalFor(row);
  const hold = holdDaysFor(row.age_days);
  const riskLine =
    row.risk_grade === 'A' || row.risk_grade === 'B'
      ? `Risk grade ${row.risk_grade} (${row.risk_score}/100) is low, so the full $${capital} position is reasonable.`
      : `Risk grade ${row.risk_grade} (${row.risk_score}/100) is not low, so cap this farm at $${capital} and no more.`;
  return [
    `Open a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline. Cost: under $3 of gas for the first transaction. Time: 5 minutes.`,
    `${actionFor(row, capital)} Cost: $${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas. Time: 15 minutes to set up.`,
    `${riskLine} Cost: the $${capital} stays in the position. Time: 2 minutes to set the cap.`,
    `Do one qualifying action each week — a deposit, a borrow, a swap or a vote — so the wallet stays active. Cost: about $2 of gas a week. Time: 10 minutes a week.`,
    `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot. Cost: the $${capital} stays in the position. Time: ${hold} days.`,
    `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes, then write the wallet, the dates and every transaction in a farm log. Cost: no fee to check, and never pay to claim. Time: 15 minutes.`,
  ];
}

// --- Detail view ---

const FACTOR_NAMES = {
  concentration: 'Concentration — chains',
  momentum: 'Momentum — 7-day swing',
  age: 'Age — launch timing',
  category: 'Category — path to a token',
  scale: 'Scale — thin TVL',
};

function renderDetail() {
  const box = $('detail');
  const row = D.rows.find((r) => r.slug === state.detail);
  if (!row) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  $('d-name').textContent = `#${row.rank} ${row.name} — risk grade ${row.risk_grade} (${row.risk_label})`;
  const f = row.risk_factors;
  const bars = Object.entries(FACTOR_NAMES)
    .map(
      ([k, label]) => `<div class="factor"><div class="fl"><span>${label}</span><span class="fv">${f[k]} / 20</span></div>
      <div class="bar"><i style="width:${(f[k] / 20) * 100}%"></i></div></div>`,
    )
    .join('');
  $('d-body').innerHTML = `
    <div class="kv">
      <span>Adjusted value <b>${fmt$(row.implied_value_usd)}</b></span>
      <span>Raw implied value <b>${fmt$(row.raw_implied_value_usd)}</b></span>
      <span>Risk score <b>${row.risk_score}/100</b></span>
      <span>TVL <b>${fmt$(row.tvl_usd)}</b></span>
      <span>7d <b>${fmtPct(row.change_7d)}</b></span>
      <span>Age <b>${fmtAge(row.age_days)}</b></span>
      <span>Chains <b>${row.chains.map(esc).join(', ') || '—'}</b></span>
      <span>Category <b>${esc(row.category || '—')}</b></span>
    </div>
    <p class="sub">Risk-adjusted value is the raw implied value discounted by the risk score:
    ${fmt$(row.raw_implied_value_usd)} × (1 − 0.5 × ${row.risk_score}/100) = ${fmt$(row.implied_value_usd)}.
    Growth ×${row.growth_multiplier}, maturity ×${row.maturity_multiplier}. ${esc(row.name)} records no token.</p>
    <div class="factors">${bars}</div>
    <h3>Farm plan — $${capitalFor(row)} position, grade ${esc(row.risk_grade)}</h3>
    <ol class="farm">${farmPlan(row).map((s) => `<li>${esc(s)}</li>`).join('')}</ol>`;
}

// --- Live view, stats, controls ---

function renderLive() {
  $('live-rows').innerHTML = D.live
    .map(
      (p) => `<tr><td><span class="name">${esc(p.name)}</span><span class="slug">${esc(p.slug)}</span></td>
      <td>${esc(p.category || '—')}</td>
      <td class="num">${fmt$(p.tvl_usd)}</td>
      <td class="num">${p.mcap_usd === null ? '—' : fmt$(p.mcap_usd)}</td>
      <td class="num">${fmtPct(p.change_7d)}</td></tr>`,
    )
    .join('');
}

function renderStats() {
  const scores = D.rows.map((r) => r.risk_score).sort((a, b) => a - b);
  const median = scores[Math.floor(scores.length / 2)];
  const counts = {};
  for (const r of D.rows) counts[r.risk_grade] = (counts[r.risk_grade] || 0) + 1;
  const gradeBits = ['A', 'B', 'C', 'D', 'E', 'F'].map((g) => `${g}: ${counts[g] || 0}`).join(' · ');
  $('stats').innerHTML = `
    <div class="stat"><b>${D.rows.length}</b><span>ranked protocols</span></div>
    <div class="stat"><b>${D.watchlist_size}</b><span>watchlist covered</span></div>
    <div class="stat"><b>${D.early_size}</b><span>early rows below the floor</span></div>
    <div class="stat"><b>${median}/100</b><span>median risk score</span></div>
    <div class="stat"><b>${gradeBits}</b><span>risk grades A–F</span></div>`;
}

function fillSelects() {
  const cats = [...new Set(D.rows.map((r) => r.category).filter(Boolean))].sort();
  $('cat').innerHTML = '<option value="">All categories</option>' + cats.map((c) => `<option>${esc(c)}</option>`).join('');
  const chains = [...new Set(D.rows.flatMap((r) => r.chains))].sort();
  $('chain').innerHTML = '<option value="">All chains</option>' + chains.map((c) => `<option>${esc(c)}</option>`).join('');
}

function syncControls() {
  $('q').value = state.q;
  $('cat').value = state.cat;
  $('chain').value = state.chain;
  $('risk').value = state.risk;
  $('sort').value = state.sort;
  $('watch').checked = state.watch;
}

function rerender() {
  renderBoard();
  renderDetail();
}

function init() {
  $('meta').textContent =
    `Snapshot ${D.as_of} · floor ${fmt$(D.floor_usd)}\n` +
    `Model ${D.model_version} · ${D.rows.length} rows · ${D.live.length} live\n` +
    `Source: ${D.source}`;
  fillSelects();
  readState();
  syncControls();
  renderStats();
  renderLive();
  rerender();
  // A deep link to a detail view shows the detail, not the top of the board.
  if (state.detail) $('detail').scrollIntoView();
  $('q').addEventListener('input', (e) => { state.q = e.target.value; pushState(); renderBoard(); });
  $('cat').addEventListener('change', (e) => { state.cat = e.target.value; pushState(); renderBoard(); });
  $('chain').addEventListener('change', (e) => { state.chain = e.target.value; pushState(); renderBoard(); });
  $('risk').addEventListener('change', (e) => { state.risk = e.target.value; pushState(); renderBoard(); });
  $('sort').addEventListener('change', (e) => { state.sort = e.target.value; pushState(); renderBoard(); });
  $('watch').addEventListener('change', (e) => { state.watch = e.target.checked; pushState(); renderBoard(); });
  $('reset').addEventListener('click', () => {
    state = { q: '', cat: '', chain: '', risk: '', sort: 'adj', watch: false, detail: '' };
    pushState(); syncControls(); rerender();
  });
  rowsEl.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-slug]');
    if (!tr) return;
    state.detail = state.detail === tr.dataset.slug ? '' : tr.dataset.slug;
    pushState(); rerender();
    if (state.detail) $('detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
  $('d-close').addEventListener('click', () => { state.detail = ''; pushState(); rerender(); });
  window.addEventListener('hashchange', () => { readState(); syncControls(); rerender(); });
}

init();
