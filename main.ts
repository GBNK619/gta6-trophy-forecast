// gta6-trophy-rarity-forecast-01 — forecast each GTA VI (PS5) trophy's earn rate
// on Exophase at the case target, as five quantiles per trophy.
//
// Method, per trophy, worked on the logit scale (logit(x) = ln((x/100)/(1 - x/100)),
// x clamped to 0.01..99.99):
//
//  1. Trend backbone. Over the distinct reads in the last 24 h before the
//     checkpoint, fit an OLS line logit(rate) = a + b*u, with
//     u = ln(1 + hours since 2026-11-19T00:00:00Z), using each read's slot time.
//     Duplicate reads (rates vector identical to the previous read) are dropped
//     and null rates are skipped. Read the line at u_target. With fewer than 3
//     distinct reads in the window, fall back to persistence (median = last
//     rate). The median's move from the last logit is clamped to +/-3 logit.
//  2. Stale-page prior. If every read in the case carries the identical rates
//     vector and players_tracked over a span of at least 1 h, the Exophase page
//     has not refreshed yet and the next refresh dilutes every rate: the median
//     logit is the last logit minus 1.0 and sigma is 0.6. A trophy whose last
//     rate is >= 99.9% is left near 100% (no shift). This fires on practice-like
//     cases; on a final case whose history moves, it does not fire.
//  3. Spread. sigma = sqrt((0.5*sqrt(d))^2 + resid^2 + (se_slope*dU)^2), where
//     d is the horizon in days, resid the residual standard deviation of the
//     fit, se_slope the slope's standard error and dU = u_target - u_last.
//     Floored at 0.25, capped at 2.0. Flat cases use sigma 0.6.
//  4. Quantiles at z = -1.645, -0.674, 0, 0.674, 1.645, rounded to 4 decimals,
//     clamped to 0.01..99.99 and forced non-decreasing.
//
// Deterministic: input files are read in name order; no randomness, no system
// clock, no network. The only data used is the case file itself.
//
// Usage (local): mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
// The grader runs: node /bot/main.ts with /input and /output.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

/** Quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** Standard normal quantiles at the scored levels. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];

/** Origin of the log-time axis: launch day, 2026-11-19T00:00:00Z. */
const EPOCH_MS = Date.parse("2026-11-19T00:00:00Z");
const HOUR_MS = 3_600_000;
const DAY_MINUTES = 1440;

/** How far the stale-page prior shifts the median logit down on a refresh. */
const FLAT_SHIFT = 1.0;
/** Spread used when the whole history is flat. */
const FLAT_SIGMA = 0.6;
/** Random-walk spread in logit units per square-root day. */
const WALK_SIGMA = 0.5;
/** Spread floor and ceiling. */
const SIGMA_MIN = 0.25;
const SIGMA_MAX = 2.0;
/** Largest median move, in logit, allowed away from the last logit. */
const MEDIAN_MOVE_MAX = 3;
/** A trophy at or above this rate is treated as pinned near 100%. */
const PINNED_RATE = 99.9;

interface Trophy {
  id: number;
}

interface Read {
  slot: string;
  at: string;
  players_tracked: number;
  rates: Array<number | null>;
}

interface CaseFile {
  id: string;
  at: string;
  horizon_minutes: number;
  target: string;
  levels: number[];
  trophies: Trophy[];
  history: Read[];
}

const clampPct = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const logitOf = (pct: number): number => {
  const p = clampPct(pct) / 100;
  return Math.log(p / (1 - p));
};
const invLogitPct = (l: number): number =>
  100 / (1 + Math.exp(-l));
/** x rounded to 4 decimals. */
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

/** u = ln(1 + hours since the epoch) for a millisecond timestamp. */
const uOfMs = (ms: number): number =>
  Math.log1p((ms - EPOCH_MS) / HOUR_MS);

/** True when two rate vectors agree element-wise (null equals null). */
const sameRates = (a: Array<number | null>, b: Array<number | null>): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

interface Fit {
  intercept: number;
  slope: number;
  resid: number;
  seSlope: number;
}

/** Least-squares line through (xs, ys); null when the fit is degenerate. */
function ols(xs: number[], ys: number[]): Fit | null {
  const n = xs.length;
  if (n < 3) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
  }
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    sxx += dx * dx;
    sxy += dx * (ys[i] - my);
  }
  if (!(sxx > 0)) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  let ssr = 0;
  for (let i = 0; i < n; i++) {
    const r = ys[i] - (intercept + slope * xs[i]);
    ssr += r * r;
  }
  // Residual variance with n - 2 degrees of freedom (two fitted parameters).
  const residVar = ssr / (n - 2);
  const resid = Math.sqrt(Math.max(0, residVar));
  const seSlope = Math.sqrt(residVar / sxx);
  return { intercept, slope, resid, seSlope };
}

/** Quantile row for one trophy from a median logit and a spread. */
function quantiles(medianLogit: number, sigma: number): number[] {
  const out: number[] = [];
  for (const z of Z) {
    const q = round4(clampPct(invLogitPct(medianLogit + z * sigma)));
    out.push(out.length === 0 ? q : Math.max(q, out[out.length - 1]));
  }
  return out;
}

/** Forecast one trophy. `reads` are the case history, oldest first. */
function forecastTrophy(
  trophyIndex: number,
  c: CaseFile,
  reads: Read[],
  uTarget: number,
  horizonDays: number,
): number[] {
  // Most recent non-null rate for this trophy, scanning newest first.
  let lastRate: number | null = null;
  for (let i = reads.length - 1; i >= 0; i--) {
    const r = reads[i].rates[trophyIndex];
    if (r !== null && r !== undefined && Number.isFinite(r)) {
      lastRate = r;
      break;
    }
  }
  if (lastRate === null) {
    // No observation at all: a neutral, wide forecast rather than a crash.
    return quantiles(0, SIGMA_MAX);
  }
  const lastLogit = logitOf(lastRate);
  const lastRead = reads[reads.length - 1];
  const uLast = uOfMs(Date.parse(lastRead.slot));

  // --- Stale-page prior: the whole history is one identical page. ---
  if (reads.length >= 2) {
    const first = reads[0];
    const spanH = (Date.parse(lastRead.slot) - Date.parse(first.slot)) / HOUR_MS;
    const allSame = reads.every(
      (r) =>
        r.players_tracked === first.players_tracked &&
        sameRates(r.rates, first.rates),
    );
    if (allSame && spanH >= 1) {
      const medianLogit = lastRate >= PINNED_RATE ? lastLogit : lastLogit - FLAT_SHIFT;
      return quantiles(medianLogit, FLAT_SIGMA);
    }
  }

  // --- Trend backbone over the last 24 h before the checkpoint. ---
  const atMs = Date.parse(c.at);
  const windowStart = atMs - 24 * HOUR_MS;
  const seen: Array<number | null>[] = [];
  const xs: number[] = [];
  const ys: number[] = [];
  for (const r of reads) {
    const slotMs = Date.parse(r.slot);
    if (slotMs < windowStart || slotMs > atMs) continue;
    if (seen.length > 0 && sameRates(r.rates, seen[seen.length - 1])) continue;
    seen.push(r.rates);
    const rate = r.rates[trophyIndex];
    if (rate === null || rate === undefined || !Number.isFinite(rate)) continue;
    xs.push(uOfMs(slotMs));
    ys.push(logitOf(rate));
  }

  const fit = ols(xs, ys);
  if (fit === null) {
    // Fewer than 3 distinct reads: persistence with a random-walk spread.
    const sigma = Math.min(
      SIGMA_MAX,
      Math.max(SIGMA_MIN, WALK_SIGMA * Math.sqrt(horizonDays)),
    );
    return quantiles(lastLogit, sigma);
  }

  const lineAtTarget = fit.intercept + fit.slope * uTarget;
  const medianLogit = Math.min(
    lastLogit + MEDIAN_MOVE_MAX,
    Math.max(lastLogit - MEDIAN_MOVE_MAX, lineAtTarget),
  );
  const dU = uTarget - uLast;
  const sigma = Math.min(
    SIGMA_MAX,
    Math.max(
      SIGMA_MIN,
      Math.sqrt(
        (WALK_SIGMA * Math.sqrt(horizonDays)) ** 2 +
          fit.resid ** 2 +
          (fit.seSlope * dU) ** 2,
      ),
    ),
  );
  return quantiles(medianLogit, sigma);
}

function forecastCase(c: CaseFile): { trophies: Array<{ id: number; q: number[] }> } {
  if (
    c.levels.length !== LEVELS.length ||
    c.levels.some((t, j) => t !== LEVELS[j])
  ) {
    throw new Error(
      `case ${c.id} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`,
    );
  }
  if (!Array.isArray(c.history) || c.history.length === 0) {
    throw new Error(`case ${c.id} has no history`);
  }
  if (!Array.isArray(c.trophies) || c.trophies.length === 0) {
    throw new Error(`case ${c.id} has no trophies`);
  }
  // Normalise the history once, up front: a read whose rates array does not
  // line up with the trophy list, and any non-finite rate, is treated as
  // missing data for that read rather than crashing the run or poisoning a
  // fit. The practice and final cases are well formed, so this only fires on
  // malformed input.
  const n = c.trophies.length;
  const reads = c.history.map((r) => {
    const rates =
      Array.isArray(r.rates) && r.rates.length === n
        ? r.rates.map((v) =>
            v === null || v === undefined || !Number.isFinite(v) ? null : v,
          )
        : new Array<number | null>(n).fill(null);
    return { ...r, rates };
  });
  const uTarget = uOfMs(Date.parse(c.target));
  const horizonDays = c.horizon_minutes / DAY_MINUTES;
  const trophies = c.trophies.map((t, i) => ({
    id: t.id,
    q: forecastTrophy(i, c, reads, uTarget, horizonDays),
  }));
  return { trophies };
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR)
  .filter((f) => f.endsWith(".in"))
  .sort();
for (const file of inputs) {
  const id = file.slice(0, -".in".length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), "utf8")) as CaseFile;
  const out = forecastCase(c);
  const text = `${JSON.stringify(out)}\n`;
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), text);
}
