// Measures real HTTP latency of /api/v1/finder/search against a running API (synthetic data only).
// Usage: node scripts/perf/finder-latency.mjs http://127.0.0.1:4100 [sequential=200] [concurrent=200] [concurrency=10]
const [base = 'http://127.0.0.1:4100', seqN = '200', concN = '200', conc = '10'] = process.argv.slice(2);
const meds = (await (await fetch(`${base}/api/v1/catalog/medicines?q=PerfMed&limit=50`)).json()).map((m) => m.id);
if (!meds.length) throw new Error('no synthetic medicines found');
const pick = () => `${base}/api/v1/finder/search?medicineId=${meds[Math.floor(Math.random() * meds.length)]}&lat=${(29.95 + Math.random()).toFixed(4)}&lng=${(31.35 + Math.random() * 1.4).toFixed(4)}&quantity=${1 + Math.floor(Math.random() * 3)}`;
const outcomes = {};
async function one() {
  const t = performance.now();
  const r = await fetch(pick());
  const body = await r.json();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(body)}`);
  outcomes[body.outcome] = (outcomes[body.outcome] ?? 0) + 1;
  return performance.now() - t;
}
const stats = (xs) => { const s = [...xs].sort((a, b) => a - b); const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]; return { n: s.length, p50: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), p99: +q(0.99).toFixed(1), max: +s[s.length - 1].toFixed(1) }; };
for (let i = 0; i < 10; i++) await one(); // warm-up
const seq = [];
for (let i = 0; i < Number(seqN); i++) seq.push(await one());
const concurrent = [];
const t0 = performance.now();
let next = 0;
await Promise.all(Array.from({ length: Number(conc) }, async () => { while (next++ < Number(concN)) concurrent.push(await one()); }));
const wall = (performance.now() - t0) / 1000;
console.log(JSON.stringify({ sequentialMs: stats(seq), concurrentMs: { ...stats(concurrent), concurrency: Number(conc), throughputRps: +(concurrent.length / wall).toFixed(1) }, outcomes }, null, 2));
