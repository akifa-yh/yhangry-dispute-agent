// jsc-runnable mirror of the behavioural layer of run-goldens.js, for machines
// without Node (jsc = macOS JavaScriptCore):
//   jsc -m --module-file=scripts/goldens-jsc.mjs
// Keep the fixtures in sync with scripts/run-goldens.js.
import { formatSlackMessage } from '../agent/decision.js';

let failures = 0;
function check(name, cond) {
  if (cond) print(`  ok  ${name}`);
  else { failures++; print(`FAIL  ${name}`); }
}

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

try {
  const out = render({
    recommendation: 'ACCEPT', rebuttal_strategy: 'ACCEPT_MERCHANT_NONPERFORMANCE',
    chef_attendance_assessment: 'MERCHANT_DECLINED_TO_PERFORM', evidence_strength: 'N/A',
    _fraud_signature: { verdict: 'NO_MATCH', signals: {} },
  });
  check('nonperformance accept -> nonperformance banner', out.includes('MERCHANT NON-PERFORMANCE'));
  check('nonperformance accept -> no fee-standoff story', !out.includes('add-on fee'));
  check('nonperformance accept -> no fraud story', !out.includes('STOLEN-CARD'));
} catch (e) { failures++; print('FAIL nonperformance accept renders — ' + e); }

try {
  const out = render({
    recommendation: 'ACCEPT', rebuttal_strategy: 'CLAIM_BY_CLAIM', evidence_strength: 'N/A',
    chef_attendance_assessment: 'UNCONFIRMED',
    _fraud_signature: { verdict: 'NO_MATCH', signals: {} },
  });
  check('generic accept -> generic banner', out.includes('ACCEPT RECOMMENDED'));
  check('generic accept -> never labelled fraud', !out.includes('STOLEN-CARD') && !out.includes('did not authorise'));
  check('generic accept -> no fabricated signals line', !out.includes('Signals fired'));
} catch (e) { failures++; print('FAIL generic accept renders — ' + e); }

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
  check('fraud accept -> stolen-card banner', out.includes('STOLEN-CARD FRAUD'));
  check('fraud accept -> unfired signal not asserted', !out.includes('no billing address'));
  check('fraud accept -> fired signals asserted', out.includes('issuer FR') && out.includes('fraud reason code'));
} catch (e) { failures++; print('FAIL fraud accept renders — ' + e); }

try {
  const out = render({
    recommendation: 'STRONG_COUNTER', rebuttal_strategy: 'CUSTOMER_INITIATED',
    chef_attendance_assessment: 'UNCONFIRMED', evidence_strength: 'STRONG',
    _fraud_signature: { verdict: 'NO_MATCH', signals: {} },
  });
  check('counter cheat-sheet -> voucher answer is honest check', out.includes('answer honestly'));
  check('counter cheat-sheet -> no hardcoded CVC claim', !out.includes('passed CVC'));
  check('counter cheat-sheet -> CVC verify instruction present', out.includes('open the payment in Stripe first'));
} catch (e) { failures++; print('FAIL counter cheat-sheet renders — ' + e); }

try {
  const out = render({
    recommendation: 'COUNTER_WITH_CAVEATS', rebuttal_strategy: 'SOME_FUTURE_STRATEGY',
    chef_attendance_assessment: 'UNCONFIRMED', evidence_strength: 'MODERATE',
    _fraud_signature: { verdict: 'NO_MATCH', signals: {} },
  });
  check('unknown strategy -> explicit no-canned-answer path', out.includes('no canned answer exists'));
} catch (e) { failures++; print('FAIL unknown strategy renders — ' + e); }

print(failures ? `${failures} golden failure(s)` : 'goldens-jsc: ALL OK');
