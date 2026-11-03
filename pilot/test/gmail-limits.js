// Runs gget from site/app.js against a simulated Gmail, on a virtual clock (hours pass in seconds).
// Usage: node pilot/test/gmail-limits.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const src = fs.readFileSync(path.join(__dirname, "../site/app.js"), "utf8");
const block = src.slice(src.indexOf("const RATE_REASONS"), src.indexOf("// Google access lasts"));
const MESSAGES = 13506, LANES = 4;

function reply(status, reason, headers = {}) {
  const body = reason ? { error: { errors: [{ reason }] } } : {};
  const res = { ok: status < 300, status, json: async () => body, clone: () => res, headers: { get: (k) => headers[k] ?? null } };
  return res;
}

// gmail(clock) answers one request; returns a response, or throws for a network failure
async function run(gmail) {
  let clock = 1e12;
  const timers = [];
  const pump = () => setImmediate(() => {
    if (timers.length) {
      timers.sort((a, b) => a.at - b.at);
      const t = timers.shift();
      clock = Math.max(clock, t.at);
      t.fn();
    }
  });
  let renewed = 0;
  const ctx = {
    S: { token: "t" }, Math, Promise, Error,
    Date: { now: () => clock },
    setTimeout: (fn, ms) => { timers.push({ at: clock + ms, fn }); pump(); },
    fetch: async () => { clock += 150; return gmail(clock); },
    renewAccess: async () => { renewed++; clock += 5 * 6e4; },
  };
  vm.createContext(ctx);
  vm.runInContext(block + "\nthis.gget = gget; this.flow = flow;", ctx);
  const start = clock;
  let done = 0, left = MESSAGES;
  const lane = async () => { while (left > 0) { left--; await ctx.gget("u"); done++; } };
  await Promise.all(Array.from({ length: LANES }, lane));
  return { done, renewed, minutes: (clock - start) / 6e4 };
}

(async () => {
  // Gmail allows 5 a second and answers rateLimitExceeded above that, like the failed run
  let sec = 0, count = 0;
  const limited = await run((now) => {
    const s = Math.floor(now / 1000);
    if (s !== sec) { sec = s; count = 0; }
    return ++count > 5 ? reply(403, "rateLimitExceeded") : reply(200);
  });
  assert.equal(limited.done, MESSAGES);
  console.log("rate limit, 5 a second:", limited.done, "read in", Math.round(limited.minutes), "min");

  // a 10 minute full block in the middle
  let n = 0, blockedUntil = 0;
  const blocked = await run((now) => {
    if (++n === 3000) blockedUntil = now + 10 * 6e4;
    return now < blockedUntil ? reply(429, "", { "Retry-After": "30" }) : reply(200);
  });
  assert.equal(blocked.done, MESSAGES);
  console.log("10 minute block:", blocked.done, "read in", Math.round(blocked.minutes), "min");

  // network drops and server errors
  let m = 0;
  const flaky = await run(() => {
    m++;
    if (m % 500 === 0) throw new TypeError("Failed to fetch");
    return m % 311 === 0 ? reply(503) : reply(200);
  });
  assert.equal(flaky.done, MESSAGES);
  console.log("network and 503:", flaky.done, "read");

  // access expires once, after an hour
  let expired = false, k = 0;
  const renew = await run(() => {
    if (++k === 5000 && !expired) { expired = true; return reply(401); }
    return reply(200);
  });
  assert.equal(renew.done, MESSAGES);
  assert.equal(renew.renewed, 1);
  console.log("access renewed:", renew.renewed, "time,", renew.done, "read");

  // a real refusal stops the run, with Gmail's reason
  await assert.rejects(run(() => reply(403, "insufficientPermissions")), /Gmail 403 insufficientPermissions/);
  console.log("real refusal stops: yes");

  // Gmail never answers: stops after 20 minutes, not forever
  await assert.rejects(run(() => reply(403, "rateLimitExceeded")), /20 דקות/);
  console.log("silent Gmail stops: yes");

  console.log("ALL PASSED");
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
