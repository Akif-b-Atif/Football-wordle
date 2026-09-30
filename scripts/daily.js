#!/usr/bin/env node
/**
 * Preview the daily answer schedule.
 *
 *   npm run daily                      # today
 *   npm run daily -- 2026-12-25        # a specific date
 *   npm run daily -- 2026-12-25 14     # that date plus the next 13 days
 *
 * Uses the same DAILY_SEED / DATA_FILE / ANSWER_POOL_SIZE as the server, so
 * set them the same way as in production to see the real schedule.
 * This reveals future answers — don't run it somewhere players can see.
 */
const app = require("../server");

const [start, countArg] = process.argv.slice(2);
const first = start || new Date().toISOString().slice(0, 10);
const count = Math.max(1, parseInt(countArg || "1", 10) || 1);

const base = new Date(`${first}T00:00:00Z`);
for (let i = 0; i < count; i++) {
  const key = new Date(base.getTime() + i * 86400000).toISOString().slice(0, 10);
  const p = app.dailyPlayerFor(key);
  console.log(`${key}  ${p.short_name}  (id ${p.id})`);
}
