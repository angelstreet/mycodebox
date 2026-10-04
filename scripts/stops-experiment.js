#!/usr/bin/env node
// Run a classifier over the Langfuse dataset `ghosty-stops` and record a dataset run (compare runs in the Langfuse UI).
//   node scripts/stops-experiment.js --run-name <name> [--classifier rules|jev|ai] [--dataset ghosty-stops]
// rules is free (the current stall.js). jev / ai call the real endpoints (JEV_URL + JEV_API_KEY) and cost money: one call per item.
import { defaults } from '../usage/ingest.js';
import { runExperiment } from '../usage/experiment.js';
import { reviewerUrl } from '../triage.js';
import { createPromptSource } from '../prompts.js';
import { REVIEWER_SYSTEM } from '../triage.js';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const cfg = defaults();
const classifier = arg('--classifier', 'rules');
const jevUrl = process.env.JEV_URL || '', apiKey = process.env.JEV_API_KEY || '';
if (!cfg.publicKey || !cfg.secretKey) { console.error('LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY not set'); process.exit(1); }
if (classifier !== 'rules' && (!jevUrl || !apiKey)) { console.error(`classifier ${classifier} needs JEV_URL and JEV_API_KEY`); process.exit(1); }
const prompt = await createPromptSource({ cfg, fallback: REVIEWER_SYSTEM }).get();
try {
  const s = await runExperiment({ cfg, runName: arg('--run-name'), classifier, dataset: arg("--dataset", undefined), env: { jevUrl, aiUrl: process.env.AI_URL || reviewerUrl(jevUrl), apiKey, system: prompt.text } });
  const pct = (a) => (a ? `${Math.round(a.value * 100)}% (${a.n})` : 'n/a');
  console.log(`run "${s.run}" (${s.classifier}) over ${s.dataset}: ${s.items} items, ${s.errors} errors, case ${pct(s.case_accuracy)}, verdict ${pct(s.verdict_accuracy)}, cost $${s.cost.toFixed(5)}`);
} catch (e) { console.error(e.message); process.exit(1); }
