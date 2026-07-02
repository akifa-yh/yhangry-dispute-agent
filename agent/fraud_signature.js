import { fetchChargeFromEitherAccount } from '../integrations/stripe.js';

// Reason codes & Stripe reasons that indicate the cardholder is alleging
// "I didn't authorise this charge" (as opposed to "I didn't get what I paid
// for"). Fraud-flavour disputes are the only ones where the stolen-card
// pattern is even relevant.
const FRAUD_NETWORK_CODES = new Set(['10.4', '4837', '4863']);
const FRAUD_REASONS = new Set(['fraudulent']);

// MC 4863 "Cardholder Does Not Recognize" is fraud-flavoured but frequently
// resolves when the customer remembers the charge (or a family member made
// it) — the evidence matrix's own entry says these are often winnable with
// platform-engagement proof. It therefore qualifies for signal display and
// PARTIAL_MATCH, but must never produce the STRONG_MATCH verdict that
// triggers the deterministic forced-ACCEPT (GAN review 2026-07-02).
const CAPPED_AT_PARTIAL_CODES = new Set(['4863']);

function isFraudCode(dispute) {
  if (FRAUD_REASONS.has(dispute.reason)) return true;
  if (dispute.network_reason_code && FRAUD_NETWORK_CODES.has(dispute.network_reason_code)) return true;
  return false;
}

function isForeignCard(charge, account) {
  const issuerCountry = charge?.payment_method_details?.card?.country;
  if (!issuerCountry) return { foreign: false, issuerCountry: null, expectedCountry: account === 'uk' ? 'GB' : 'US' };
  const expectedCountry = account === 'uk' ? 'GB' : 'US';
  return { foreign: issuerCountry !== expectedCountry, issuerCountry, expectedCountry };
}

function hasNoBillingAddress(charge) {
  const addr = charge?.billing_details?.address;
  if (!addr) return true;
  // Stripe returns an object with all-null fields when no address is provided.
  const fields = [addr.line1, addr.line2, addr.city, addr.state, addr.postal_code, addr.country];
  return fields.every((v) => v == null || v === '');
}

function isElevatedRisk(charge) {
  const riskLevel = charge?.outcome?.risk_level;
  return { elevated: riskLevel === 'elevated' || riskLevel === 'highest', riskLevel: riskLevel || null };
}

/**
 * Compute the stolen-card fraud signature for a dispute.
 *
 * Returns:
 *   { verdict, score, signals, account, issuerCountry, expectedCountry, riskLevel, reason }
 *
 * The fraud-code check is a prerequisite — when it's false, verdict is
 * NO_MATCH immediately and we don't bother fetching the charge. When
 * true, we score the three independent signals:
 *   - foreign_card     (issuer country ≠ account country)
 *   - no_address       (no billing address on Stripe)
 *   - elevated_risk    (Stripe Radar risk_level elevated or highest)
 *
 * Verdict mapping (per the threshold Aki approved 2026-05-18):
 *   - 3 of 3 → STRONG_MATCH  (deterministic ACCEPT override)
 *   - 2 of 3 → PARTIAL_MATCH (LLM weighs against platform engagement)
 *   - ≤1 of 3 → NO_MATCH    (normal flow)
 *
 * Charge fetch is best-effort: if Stripe is unreachable or the charge
 * isn't in either account, we degrade to NO_MATCH with `reason` populated
 * so the LLM still sees the signals it can compute (fraud_code only) and
 * the caller can decide whether to log/escalate.
 */
export async function computeFraudSignature(dispute) {
  const fraudCode = isFraudCode(dispute);

  const base = {
    score: 0,
    signals: { fraud_code: fraudCode, foreign_card: false, no_address: false, elevated_risk: false },
    account: null,
    issuerCountry: null,
    expectedCountry: null,
    riskLevel: null,
    reason: null,
  };

  if (!fraudCode) {
    return { ...base, verdict: 'NO_MATCH', reason: 'Not a fraud-code dispute' };
  }

  const chargeId = dispute.charge;
  if (!chargeId) {
    return { ...base, verdict: 'NO_MATCH', reason: 'Dispute has no charge id' };
  }

  let charge;
  let account;
  try {
    const result = await fetchChargeFromEitherAccount(chargeId);
    charge = result.charge;
    account = result.account;
  } catch (err) {
    console.error(`[fraud_signature] Could not fetch charge ${chargeId}: ${err.message}`);
    return { ...base, verdict: 'NO_MATCH', reason: `Charge fetch failed: ${err.message}` };
  }

  const { foreign, issuerCountry, expectedCountry } = isForeignCard(charge, account);
  const noAddress = hasNoBillingAddress(charge);
  const { elevated, riskLevel } = isElevatedRisk(charge);

  const signals = {
    fraud_code: true,
    foreign_card: foreign,
    no_address: noAddress,
    elevated_risk: elevated,
  };

  // Score the three non-prerequisite signals.
  const nonPrereqHits = [foreign, noAddress, elevated].filter(Boolean).length;
  let verdict;
  if (nonPrereqHits === 3) verdict = 'STRONG_MATCH';
  else if (nonPrereqHits === 2) verdict = 'PARTIAL_MATCH';
  else verdict = 'NO_MATCH';

  // 4863 cap: "doesn't recognize" is not "didn't authorise" — show the
  // signals but leave the ACCEPT decision to the LLM + ops.
  if (
    verdict === 'STRONG_MATCH' &&
    !FRAUD_REASONS.has(dispute.reason) &&
    CAPPED_AT_PARTIAL_CODES.has(dispute.network_reason_code)
  ) {
    verdict = 'PARTIAL_MATCH';
  }

  return {
    verdict,
    score: nonPrereqHits,
    signals,
    account,
    issuerCountry,
    expectedCountry,
    riskLevel,
    reason: null,
  };
}
