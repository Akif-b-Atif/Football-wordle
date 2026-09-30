/**
 * Daily answer scheduling.
 *
 * Goals:
 *  - Deterministic: the answer for any date (past or future) can be computed
 *    from (date, DAILY_SEED, answer pool) alone, so it is stable across
 *    restarts/instances and can be previewed with `npm run daily`.
 *  - Not incremental: there is no relationship between consecutive days.
 *  - Fair: every player in the answer pool appears exactly once per cycle
 *    (a cycle is ANSWER_POOL.length days) before any player repeats, and the
 *    last answer of one cycle is never the first answer of the next.
 *
 * How: each cycle gets its own Fisher-Yates shuffle of the pool, driven by a
 * PRNG stream derived from HMAC-SHA256(DAILY_SEED, "cycle:<n>:<counter>").
 * The day's answer is the player at (dayNumber mod poolSize) in that shuffle.
 *
 * NOTE: the schedule depends on DAILY_SEED and on the contents/order of the
 * answer pool. Changing either (including ANSWER_POOL_SIZE) reshuffles it.
 * Set a private DAILY_SEED in production, otherwise the default is public.
 */

const crypto = require("crypto");

const MS_PER_DAY = 86400000;

// "YYYY-MM-DD" -> whole days since 1970-01-01 (UTC).
function dayNumberOf(dateKey) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!m) throw new Error(`Invalid date key "${dateKey}", expected YYYY-MM-DD`);
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const back = new Date(ms).toISOString().slice(0, 10);
  if (Number.isNaN(ms) || back !== dateKey) throw new Error(`Invalid calendar date "${dateKey}"`);
  return Math.floor(ms / MS_PER_DAY);
}

// Uniform integer in [0, n) from an HMAC-based stream (rejection sampling,
// so there is no modulo bias).
function makeRng(seed, cycle) {
  let counter = 0;
  let buf = Buffer.alloc(0);
  let off = 0;
  function nextUint32() {
    if (off + 4 > buf.length) {
      buf = crypto.createHmac("sha256", seed).update(`cycle:${cycle}:${counter++}`).digest();
      off = 0;
    }
    const v = buf.readUInt32BE(off);
    off += 4;
    return v;
  }
  return function randInt(n) {
    const limit = Math.floor(0x100000000 / n) * n;
    let v;
    do {
      v = nextUint32();
    } while (v >= limit);
    return v % n;
  };
}

// Seeded Fisher-Yates permutation of [0, n) for a given cycle.
function rawPermutation(n, seed, cycle) {
  const perm = Array.from({ length: n }, (_, i) => i);
  const randInt = makeRng(seed, cycle);
  for (let i = n - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  return perm;
}

// Permutation for a cycle, with a guard so a player never appears on two
// consecutive days across a cycle boundary.
function cyclePermutation(n, seed, cycle) {
  const perm = rawPermutation(n, seed, cycle);
  if (n > 2) {
    const prevLast = rawPermutation(n, seed, cycle - 1)[n - 1];
    if (perm[0] === prevLast) [perm[0], perm[1]] = [perm[1], perm[0]];
  }
  return perm;
}

function createDailyScheduler(pool, seed) {
  if (!Array.isArray(pool) || pool.length === 0) throw new Error("Answer pool is empty");
  if (!seed) throw new Error("A daily seed is required");
  const n = pool.length;

  // Tiny cache: requests for "today" all hit the same cycle.
  const cache = new Map();
  function permFor(cycle) {
    if (!cache.has(cycle)) {
      if (cache.size >= 8) cache.delete(cache.keys().next().value);
      cache.set(cycle, cyclePermutation(n, seed, cycle));
    }
    return cache.get(cycle);
  }

  return function dailyPlayerFor(dateKey) {
    const day = dayNumberOf(dateKey);
    const cycle = Math.floor(day / n);
    const pos = day - cycle * n; // non-negative even for pre-1970 dates
    return pool[permFor(cycle)[pos]];
  };
}

module.exports = { createDailyScheduler, dayNumberOf };
