// Audits past run.json transcripts for actor/perspective swaps.
//
// Expected mapping (from src/llmResponder.js):
//   requestorGettingStarted   -> EMPLOYEE  -> first-person self-assessment ("I/my own work")
//   participantGettingStarted -> MANAGER   -> third-person evaluation ("the employee / they / their")
//
// A "swap" is a synthetic-user turn whose language matches the OTHER actor's
// perspective. We classify each turn's text and flag mismatches.
//
// Usage: node scripts/auditPerspectiveSwaps.js [--verbose]

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const VERBOSE = process.argv.includes('--verbose');
const RESULTS = 'results';

// First-person self-assessment markers (employee speaking about own work).
// Mirrors the manager-perspective guard in src/llmResponder.js:1176.
const SELF_MARKERS = /\b(?:my role|my performance|my work|my own|my development|my manager|i manage|i deliver|i led|i am responsible|i'm responsible|i need|i would benefit|i improved|i reduced|i exceeded|my time and energy|my priorities|my goals?)\b/gi;

// Third-person evaluator markers (manager speaking about the employee).
const EVAL_MARKERS = /\b(?:the employee|this employee|employee's|the employee is|the employee has|their role|their performance|their work|their development|as (?:the|their) manager|they (?:demonstrate|struggle|deliver|need|require|show)s?)\b/gi;

function classify(text) {
  const t = String(text || '');
  const self = (t.match(SELF_MARKERS) || []).length;
  const evalc = (t.match(EVAL_MARKERS) || []).length;
  if (self === 0 && evalc === 0) return { perspective: 'unknown', self, evalc };
  if (self > evalc) return { perspective: 'employee', self, evalc };
  if (evalc > self) return { perspective: 'manager', self, evalc };
  return { perspective: 'ambiguous', self, evalc };
}

function findRunJsons(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (!statSync(p).isDirectory()) continue;
    const direct = join(p, 'run.json');
    if (existsSync(direct)) out.push(direct);
    // multi-case runs nest case-NNN/
    for (const sub of readdirSync(p)) {
      const cj = join(p, sub, 'run.json');
      if (sub.startsWith('case-') && existsSync(cj)) out.push(cj);
    }
  }
  return out;
}

const SIDES = [
  { key: 'requestorGettingStarted', actor: 'requestor', expect: 'employee' },
  { key: 'participantGettingStarted', actor: 'participant', expect: 'manager' }
];

let totalTurns = 0;
let totalSwaps = 0;
let runsWithSwaps = 0;
const swapDetails = [];

for (const file of findRunJsons(RESULTS)) {
  let d;
  try { d = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
  const t = d.transcripts || {};
  let runSwaps = 0;

  for (const side of SIDES) {
    const turns = (t[side.key] || []).filter((e) => e && e.role === 'syntheticUser');
    for (const turn of turns) {
      totalTurns++;
      const c = classify(turn.text);
      // Only count a swap when the turn clearly speaks in the OTHER actor's voice.
      const swapped =
        (side.expect === 'employee' && c.perspective === 'manager') ||
        (side.expect === 'manager' && c.perspective === 'employee');
      if (swapped) {
        totalSwaps++;
        runSwaps++;
        swapDetails.push({
          file: file.replace(/\\/g, '/'),
          side: side.actor,
          expected: side.expect,
          got: c.perspective,
          turn: turn.turn,
          self: c.self,
          evalc: c.evalc,
          excerpt: String(turn.text || '').slice(0, 160).replace(/\s+/g, ' ')
        });
      }
    }
  }
  if (runSwaps > 0) runsWithSwaps++;
}

console.log('=== Perspective-swap audit ===');
console.log('run.json files scanned :', findRunJsons(RESULTS).length);
console.log('synthetic-user turns   :', totalTurns);
console.log('runs with >=1 swap     :', runsWithSwaps);
console.log('total swapped turns    :', totalSwaps,
  totalTurns ? `(${((totalSwaps / totalTurns) * 100).toFixed(1)}% of turns)` : '');

// Break down by side
const bySide = {};
for (const s of swapDetails) {
  const k = `${s.side} (expected ${s.expected}) spoke as ${s.got}`;
  bySide[k] = (bySide[k] || 0) + 1;
}
console.log('\n--- swap directions ---');
for (const [k, v] of Object.entries(bySide)) console.log(`  ${v.toString().padStart(4)}  ${k}`);

if (VERBOSE) {
  console.log('\n--- sample swapped turns (up to 25) ---');
  for (const s of swapDetails.slice(0, 25)) {
    console.log(`\n[${s.side}->spoke as ${s.got}] turn ${s.turn}  self=${s.self} eval=${s.evalc}`);
    console.log('  ', s.file);
    console.log('   "' + s.excerpt + '..."');
  }
}
