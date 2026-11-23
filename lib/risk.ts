// Risk-scored token radar — the model (lib/risk.ts).
//
// Angle: risk scoring. The starter ranks pre-token protocols by a raw implied
// value (TVL x multiple x growth x maturity). This model ranks them by a
// RISK-ADJUSTED implied value: the same snapshot figures produce a raw implied
// value, and then a risk score built from five more of the snapshot's own
// figures discounts it. A big, fast-growing protocol on one chain, three weeks
// old, scores worse than a smaller, steadier one spread over five chains —
// because the farm that chases it is the riskier farm.
//
// Nothing here names a protocol. Every number comes from the protocol's own
// record (tvl_usd, change_7d, listed_at, chains, category) plus the watchlist
// the snapshot carries. The constants are this model's, stated in the
// dashboard and changeable in one place below.
//
//   raw implied  = tvl_usd x 0.30 x growthMult x maturityMult
//   growthMult   = 1 + clamp(change_7d, -50, 100) / 100 x 0.6
//   maturityMult = 0.5 + min(age_days, 1460) / 1460 x 0.5   (age unknown: 365)
//   risk score   = concentration + momentum + age + category + scale  (each 0-20)
//   adjusted     = round(raw x (1 - 0.5 x risk / 100))
//
// The board ranks by adjusted value, highest first. A risk of 100 keeps half
// the raw value; a risk of 0 keeps all of it. Each row carries its raw value,
// its risk score and grade, and the five factor scores, so the ranking can be
// checked factor by factor.

/** One protocol of the sealed snapshot: exactly its ten fields. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants: the dashboard states them and the page may quote them. */
export interface ModelConstants {
  base_multiple: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  risk_discount: number;
}

export const MODEL: ModelConstants = {
  base_multiple: 0.3,
  growth_weight: 0.6,
  growth_floor: -50,
  growth_cap: 100,
  maturity_floor: 0.5,
  maturity_range: 0.5,
  maturity_days: 1460,
  unknown_age_days: 365,
  risk_discount: 0.5,
};

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'risk-2';

/** A risk grade: the letter the board shows and the words behind it. */
export type RiskGrade = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

export const RISK_GRADES: { grade: RiskGrade; max: number; label: string }[] = [
  { grade: 'A', max: 30, label: 'Low' },
  { grade: 'B', max: 42, label: 'Guarded' },
  { grade: 'C', max: 52, label: 'Moderate' },
  { grade: 'D', max: 62, label: 'Elevated' },
  { grade: 'E', max: 72, label: 'High' },
  { grade: 'F', max: 100, label: 'Severe' },
];

/** The five risk factors, each 0-20, that sum to the risk score. */
export interface RiskFactors {
  concentration: number;
  momentum: number;
  age: number;
  category: number;
  scale: number;
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Whole days from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The raw implied value and its multipliers for one protocol under `model`. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
): { raw: number; growthPct: number; growthMult: number; maturityMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult =
    model.maturity_floor +
    (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const raw = Math.max(1, Math.round(protocol.tvl_usd * model.base_multiple * growthMult * maturityMult));
  return { raw, growthPct, growthMult, maturityMult, age };
}

/**
 * Concentration risk (0-20): a protocol on one chain has one chain's outage,
 * fee spike or halt between it and its TVL. More chains, less of it.
 */
export function concentrationRisk(chains: string[]): number {
  const n = chains.length;
  if (n <= 1) return 20;
  if (n === 2) return 14;
  if (n === 3) return 9;
  if (n <= 5) return 5;
  return 2;
}

/**
 * Momentum risk (0-20): a violent seven-day swing, up or down, is TVL that
 * may not stay. No reported change is unknown, and unknown is not safe.
 */
export function momentumRisk(change7d: number | null): number {
  if (change7d === null || !Number.isFinite(change7d)) return 12;
  const g = Math.abs(change7d);
  if (g <= 5) return 3;
  if (g <= 15) return 7;
  if (g <= 30) return 12;
  if (g <= 60) return 16;
  return 20;
}

/**
 * Age risk (0-20): very young is unproven; very old with still no token is a
 * launch that may never come. The middle — a year or three of running — is
 * the proven ground. This deliberately pulls against the maturity
 * multiplier, which rewards age: staying power raises the raw value, while
 * the chance the token never arrives discounts it.
 */
export function ageRisk(age: number | null): number {
  if (age === null) return 12;
  if (age < 90) return 18;
  if (age < 365) return 10;
  if (age < 1095) return 4;
  if (age < 1825) return 12;
  return 17;
}

/**
 * Category risk (0-20): how settled a category's path to a token is. Dexes
 * and lenders have issued tokens for years; wrappers and exotic structures
 * have a thinner record. A category this table does not name scores 12.
 */
const CATEGORY_RISK: Record<string, number> = {
  Dexs: 5,
  Lending: 5,
  Yield: 7,
  'Yield Aggregator': 7,
  Derivatives: 9,
  CDP: 8,
  'Collateral Markets': 9,
  'CDP Manager': 9,
  'Onchain Capital Allocator': 10,
  'Liquidity Manager': 10,
  'Interest Rate Derivatives': 10,
  'Risk Curators': 11,
  Indexes: 11,
  RWA: 12,
  'Basis Trading': 12,
  'Prediction Market': 12,
  Farm: 12,
  'Leveraged Farming': 13,
  Insurance: 13,
  Payments: 13,
  'Governance Incentives': 13,
  'Options Vault': 12,
  Chain: 14,
  'Decentralized BTC': 14,
  'OTC Marketplace': 14,
  CeDeFi: 14,
  'Uncollateralized Lending': 15,
  'Anchor BTC': 15,
  'Dual-Token Stablecoin': 15,
  'Stablecoin Wrapper': 15,
  'Crypto Card Issuer': 15,
  Privacy: 14,
};

export function categoryRisk(category: string | null): number {
  if (category === null) return 12;
  return CATEGORY_RISK[category] ?? 12;
}

/**
 * Scale risk (0-20): thin TVL is easier to move, easier to fake and quicker
 * to leave. A billion-plus protocol has been stress-tested by its own size.
 */
export function scaleRisk(tvlUsd: number): number {
  if (tvlUsd < 10_000_000) return 18;
  if (tvlUsd < 50_000_000) return 14;
  if (tvlUsd < 250_000_000) return 9;
  if (tvlUsd < 1_000_000_000) return 5;
  return 2;
}

/** The five factor scores and their sum for one protocol. */
export function riskScore(
  protocol: SnapshotProtocol,
  age: number | null,
): { score: number; factors: RiskFactors } {
  const factors: RiskFactors = {
    concentration: concentrationRisk(protocol.chains),
    momentum: momentumRisk(protocol.change_7d),
    age: ageRisk(age),
    category: categoryRisk(protocol.category),
    scale: scaleRisk(protocol.tvl_usd),
  };
  const score = factors.concentration + factors.momentum + factors.age + factors.category + factors.scale;
  return { score, factors };
}

/** The grade letter and label for a risk score. */
export function riskGrade(score: number): { grade: RiskGrade; label: string } {
  for (const g of RISK_GRADES) {
    if (score <= g.max) return { grade: g.grade, label: g.label };
  }
  return { grade: 'F', label: 'Severe' };
}

/** The risk-adjusted value: the raw value discounted by the risk score. */
export function adjustedValue(raw: number, risk: number, model: ModelConstants): number {
  return Math.max(1, Math.round(raw * (1 - model.risk_discount * (risk / 100))));
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** A name carrying a whole word wrapped, staked or staking. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** A name beginning with an exchange's name. */
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/**
 * Whether a protocol is one the board may rank on its own record: pre-token,
 * and not a wrapped, staked or bridged product of a token that already trades
 * (bridge or staking category, a wrapped/staked word in the name, an
 * exchange's name, a version marker, or a CEX). The watchlist is the floor:
 * every watchlist slug ranks whatever its record says, because the house put
 * it there; this rule governs the early rows the board adds below it.
 */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('bridge') || c.includes('stak') || c === 'cex') return false;
  if (VERSIONED.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  if (EXCHANGE_PREFIX.test(p.name)) return false;
  return true;
}

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  raw_implied_value_usd: number;
  risk_score: number;
  risk_grade: RiskGrade;
  risk_label: string;
  risk_factors: RiskFactors;
  model: {
    base_multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row, with the farm plan generated in the page. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  raw_implied_value_usd: number;
  risk_score: number;
  risk_grade: RiskGrade;
  risk_label: string;
  risk_factors: RiskFactors;
  growth_multiplier: number;
  maturity_multiplier: number;
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug ranks, even one this model's own
  // rankable rule would leave out. The house put it there; the board covers it.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every other rankable pre-token protocol, below the floor
  // or above it — the whole pre-token universe the snapshot allows, not a
  // top-N cut by TVL. A chosen protocol stays chosen.
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isRankable(p)) chosen.set(p.slug, p);
  }

  const scored = [...chosen.values()].map((p) => {
    const { raw, growthPct, growthMult, maturityMult, age } = impliedValue(p, snapshot.as_of, model);
    const { score, factors } = riskScore(p, age);
    const { grade, label } = riskGrade(score);
    const adjusted = adjustedValue(raw, score, model);
    return { p, raw, growthPct, growthMult, maturityMult, age, score, factors, grade, label, adjusted };
  });
  scored.sort(
    (a, b) => b.adjusted - a.adjusted || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0),
  );
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.adjusted,
    raw_implied_value_usd: s.raw,
    risk_score: s.score,
    risk_grade: s.grade,
    risk_label: s.label,
    risk_factors: s.factors,
    model: {
      base_multiple: model.base_multiple,
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growthMult),
      maturity_multiplier: round4(s.maturityMult),
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age, s.score, s.grade).map(stepText),
  }));
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/**
 * How much capital one farm position needs, from the protocol's own TVL —
 * then cut by its risk grade. A severe-risk farm gets a quarter of the
 * capital a low-risk one does: the plan sizes the position to the risk.
 */
export function capitalFor(p: SnapshotProtocol, grade: RiskGrade): number {
  let base: number;
  if (p.tvl_usd >= 5_000_000_000) base = 250;
  else if (p.tvl_usd >= 1_000_000_000) base = 150;
  else if (p.tvl_usd >= 100_000_000) base = 100;
  else base = 50;
  const cut: Record<RiskGrade, number> = { A: 1, B: 1, C: 0.6, D: 0.4, E: 0.25, F: 0.25 };
  return Math.max(25, Math.round((base * cut[grade]) / 5) * 5);
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's one action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral'))
    return `Lend $${capital} of USDC on ${name} (${chain}) and leave the supply earning.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm'))
    return `Add $${capital} of liquidity to ${name}'s deepest pool on ${chain} and keep it in range.`;
  if (c.includes('perpetual') || c.includes('derivative'))
    return `Post $${capital} of USDC as margin on ${name} and open one small hedged position.`;
  if (c.includes('prediction'))
    return `Fund $${capital} on ${name} and take one position in an active market.`;
  if (c.includes('curator') || c.includes('allocator'))
    return `Deposit $${capital} into a ${name} vault on ${chain} and hold the vault shares.`;
  if (c.includes('stable'))
    return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa'))
    return `Mint $${capital} of ${name}'s yield-bearing asset on ${chain} and hold it.`;
  if (c.includes('insurance'))
    return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy live.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time.
 * The plan is derived from the protocol's own record (category, chains, TVL,
 * age, risk grade), never from a hand-written list of names — and the third
 * step sizes the position to the risk grade, so a severe-risk farm is a small
 * farm by construction.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null, score: number, grade: RiskGrade): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p, grade);
  const hold = holdDaysFor(age);
  const action = actionFor(p, capital, chain);
  const riskLine =
    grade === 'A' || grade === 'B'
      ? `Risk grade ${grade} (${score}/100) is low, so the full $${capital} position is reasonable.`
      : `Risk grade ${grade} (${score}/100) is not low, so cap this farm at $${capital} and no more.`;
  return [
    {
      text: `Open a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: action,
      cost: `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: riskLine,
      cost: `the $${capital} stays in the position`,
      time: '2 minutes to set the cap',
    },
    {
      text: `Do one qualifying action each week — a deposit, a borrow, a swap or a vote — so the wallet stays active.`,
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes, then write the wallet, the dates and every transaction in a farm log.`,
      cost: 'no fee to check, and never pay to claim',
      time: '15 minutes',
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js, with the farm plan generated in the page. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    raw_implied_value_usd: row.raw_implied_value_usd,
    risk_score: row.risk_score,
    risk_grade: row.risk_grade,
    risk_label: row.risk_label,
    risk_factors: row.risk_factors,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
