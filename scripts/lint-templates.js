// Template-honesty lint (added 2026-07-11 after the Lawrence Suen incident).
//
// FAILURE CLASS THIS PREVENTS: a past case's facts (names, voucher codes,
// case-specific phrases) baked into STRING LITERALS that render for every
// future case — Slack banners, cheat-sheets, prompts, matrix entries.
//
// POLICY: exemplar tokens may appear
//   - in COMMENTS (case citations are good documentation), and
//   - in strings ONLY on lines that clearly mark them as attribution or
//     illustration ("Source case:", "illustrative", "past case", "worked
//     example", "archetype", "lesson").
// Anything else fails the build.
//
// Run: node scripts/lint-templates.js
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Past-case identifiers. Add every new training case's tokens here.
const EXEMPLAR_TOKENS = [
  'Maddie', 'Fuhrman',
  'Khushbu', 'Aggarwal', 'KHU50AGG',
  'Katie', 'Robertson',
  'Tatiana', 'Hakim',
  'Brad', 'Gabrys',
  'Tyler',
  'Trey Quan', 'tquan3',
  'Lawrence', 'Suen',
  'Shelby', 'Craig',
  'Strickland',
  // case-specific phrases that must never be generic template copy
  'add-on fee the customer never agreed to',
  "don't mention the 20%",
  '...1003',
];

const ALLOW_MARKERS = [
  'source case', 'illustrative', 'past case', 'worked example', 'archetype', 'lesson',
];

const FILES = [];
for (const dir of ['agent', 'integrations', 'utils', 'evidence']) {
  try {
    for (const f of readdirSync(path.join(ROOT, dir))) {
      if (f.endsWith('.js')) FILES.push(path.join(dir, f));
    }
  } catch { /* dir may not exist */ }
}
FILES.push('server.js');

// Strip comments so citations in comments never trip the lint. Crude but
// adequate: removes // to end-of-line and /* ... */ blocks. String contents
// are preserved (we do not parse; a "//" inside a string is an accepted
// blind spot — none of our templates contain URLs with exemplar tokens).
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

let failures = 0;
for (const rel of FILES) {
  let src;
  try {
    src = readFileSync(path.join(ROOT, rel), 'utf8');
  } catch {
    continue;
  }
  const stripped = stripComments(src);
  const lines = stripped.split('\n');
  lines.forEach((line, i) => {
    for (const tok of EXEMPLAR_TOKENS) {
      if (!line.includes(tok)) continue;
      const lower = line.toLowerCase();
      if (ALLOW_MARKERS.some((m) => lower.includes(m))) continue;
      failures++;
      console.error(`LINT FAIL ${rel}:${i + 1} — exemplar token "${tok}" in non-comment code without an attribution marker:`);
      console.error(`    ${line.trim().slice(0, 160)}`);
    }
  });
}

if (failures) {
  console.error(`\n${failures} template-honesty violation(s). Case facts belong in the case analysis, not in templates.`);
  process.exit(1);
}
console.log(`lint-templates: OK (${FILES.length} files scanned)`);
