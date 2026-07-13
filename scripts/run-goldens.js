// Golden regression checks (added 2026-07-11 with the template-honesty batch).
//
// Two layers:
//   1. SOURCE ASSERTIONS — the specific overreach/contradiction fixes from the
//      2026-07-11 audit must stay fixed (cheap greps against the source).
//   2. BEHAVIOURAL GOLDENS — formatSlackMessage rendered against fixture
//      analyses modelled on past cases; asserts the right banner fires and no
//      case-fact template leaks. Every future training case should add a
//      fixture here so new training cannot silently break old behaviour.
//
// Run: node scripts/run-goldens.js
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { formatSlackMessage } from '../agent/decision.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ---------------------------------------------------------------------------
// 1. Source assertions
// ---------------------------------------------------------------------------
const decision = readFileSync(path.join(ROOT, 'agent/decision.js'), 'utf8');
const prompt = readFileSync(path.join(ROOT, 'agent/prompt.js'), 'utf8');
const matrix = readFileSync(path.join(ROOT, 'agent/evidence_matrix.js'), 'utf8');
const analyser = readFileSync(path.join(ROOT, 'agent/exhibit_analyser.js'), 'utf8');

console.log('source assertions:');
check('non-performance banner is generic', !decision.includes('add-on fee the customer never agreed to'));
check('stolen-card banner is gated on STRONG_MATCH', decision.includes("_fraud_signature?.verdict === 'STRONG_MATCH'"));
check('generic ACCEPT banner exists', decision.includes('ACCEPT RECOMMENDED — do NOT counter'));
check('voucher answer is a check, not a "No"', !decision.includes("'• *Offered a credit or voucher:* No'"));
check('no unconditional CVC/AVS-passed claim', !decision.includes('the payment passed CVC and billing-postcode checks'));
check('no unconditional timely-complaint fallback', !decision.includes('did not raise a timely complaint.\''));
check('admission banner is calibrated, not "almost every time"', !decision.includes('almost every time'));
check('MERCHANT_DECLINED_TO_PERFORM covers chef no-show', prompt.includes('medical'));
check('escalate rule no longer swallows confirmed chef no-shows', prompt.includes('is NOT an escalate'));
check('no invented "change = fee" policy clause', !prompt.includes('Under yhangry policy, inside the 7-day'));
check('deadline point is evidence-conditional in surcharge sub-type', prompt.includes('CHECK the\nfirst-contact timestamp') || prompt.includes('CHECK the first-contact timestamp'));
check('C02 has multiple win paths', matrix.includes('Win paths'));
check('C02 carries no exemplar voucher code', !matrix.includes('KHU50AGG'));
check('12.5 admission source has no canonical customer quote', !matrix.includes('I will cancel the dispute with my card'));
check('exhibit analyser accepts legitimate post-event dates', analyser.includes('do not "correct" them toward the event date'));

// ---------------------------------------------------------------------------
// 2. Behavioural goldens
// ---------------------------------------------------------------------------
const baseDispute = {
  id: 'du_golden_test', amount: 93600, currency: 'usd', reason: 'product_not_received',
  network_reason_code: 'C31', charge: 'ch_golden', evidence_details: { due_by: 1790000000 },
};
const baseBooking = { order_id: 999999, event_date: '2026-07-08', customer_name: 'Golden Fixture' };
const baseAnalysis = {
  narrative_provided: false,
  customer_claims: [], claim_analysis: [], unaddressed_claims: [],
  suggested_rebuttal_points: ['point'], evidence_to_include: [], evidence_weaknesses: [],
  reasoning: 'golden fixture reasoning',
  deadline_analysis: null,
};
const render = (a) => JSON.stringify(formatSlackMessage({ ...baseAnalysis, ...a }, baseDispute, baseBooking));

console.log('behavioural goldens:');
// Lawrence-class: chef-fault non-performance accept (medical no-show)
try {
  const out = render({
    recommendation: 'ACCEPT', rebuttal_strategy: 'ACCEPT_MERCHANT_NONPERFORMANCE',
    chef_attendance_assessment: 'MERCHANT_DECLINED_TO_PERFORM', evidence_strength: 'N/A',
    _fraud_signature: { verdict: 'NO_MATCH', signals: {} },
  });
  check('nonperformance accept → nonperformance banner', out.includes('MERCHANT NON-PERFORMANCE'));
  check('nonperformance accept → no fee-standoff story', !out.includes('add-on fee'));
  check('nonperformance accept → no fraud story', !out.includes('STOLEN-CARD'));
} catch (e) { check('nonperformance accept renders', false, e.message); }

// Generic accept (neither non-performance nor fraud STRONG_MATCH)
try {
  const out = render({
    recommendation: 'ACCEPT', rebuttal_strategy: 'CLAIM_BY_CLAIM', evidence_strength: 'N/A',
    chef_attendance_assessment: 'UNCONFIRMED',
    _fraud_signature: { verdict: 'NO_MATCH', signals: {} },
  });
  check('generic accept → generic banner', out.includes('ACCEPT RECOMMENDED'));
  check('generic accept → never labelled fraud', !out.includes('STOLEN-CARD') && !out.includes('did not authorise'));
  check('generic accept → no fabricated signals line', !out.includes('Signals fired'));
} catch (e) { check('generic accept renders', false, e.message); }

// Fraud accept: STRONG_MATCH renders the fraud banner with only fired signals
try {
  const out = render({
    recommendation: 'ACCEPT', rebuttal_strategy: 'ACCEPT_STOLEN_CARD', evidence_strength: 'N/A',
    chef_attendance_assessment: 'UNCONFIRMED',
    _fraud_signature: {
      verdict: 'STRONG_MATCH',
      signals: { fraud_code: true, foreign_card: true, no_address: false, elevated_risk: true },
      issuerCountry: 'FR', expectedCountry: 'US', riskLevel: 'elevated',
    },
  });
  check('fraud accept → stolen-card banner', out.includes('STOLEN-CARD FRAUD'));
  check('fraud accept → unfired signal not asserted', !out.includes('no billing address'));
  check('fraud accept → fired signals asserted', out.includes('issuer FR') && out.includes('fraud reason code'));
} catch (e) { check('fraud accept renders', false, e.message); }

// Counter: cheat-sheet honesty
try {
  const out = render({
    recommendation: 'STRONG_COUNTER', rebuttal_strategy: 'CUSTOMER_INITIATED',
    chef_attendance_assessment: 'UNCONFIRMED', evidence_strength: 'STRONG',
    _fraud_signature: { verdict: 'NO_MATCH', signals: {} },
  });
  check('counter cheat-sheet → voucher answer is honest check', out.includes('answer honestly'));
  check('counter cheat-sheet → no hardcoded CVC claim', !out.includes('passed CVC'));
  check('counter cheat-sheet → CVC verify instruction present', out.includes('open the payment in Stripe first'));
} catch (e) { check('counter cheat-sheet renders', false, e.message); }

// Unknown strategy: no canned paste answer
try {
  const out = render({
    recommendation: 'COUNTER_WITH_CAVEATS', rebuttal_strategy: 'SOME_FUTURE_STRATEGY',
    chef_attendance_assessment: 'UNCONFIRMED', evidence_strength: 'MODERATE',
    _fraud_signature: { verdict: 'NO_MATCH', signals: {} },
  });
  check('unknown strategy → explicit no-canned-answer path', out.includes('no canned answer exists'));
} catch (e) { check('unknown strategy renders', false, e.message); }

console.log('');
if (failures) {
  console.error(`${failures} golden failure(s).`);
  process.exit(1);
}
console.log('run-goldens: OK');
