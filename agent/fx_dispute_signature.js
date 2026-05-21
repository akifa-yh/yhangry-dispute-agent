import { fetchChargeFromEitherAccount } from '../integrations/stripe.js';

// Reason codes that indicate a "processing error" family dispute — the
// category that catches FX-gap, currency-mismatch, amount-incorrect,
// duplicate-processing, and paid-by-other-means complaints. These are the
// codes the Katie Robertson session (2026-05-20) identified as
// structurally hard to win via the formal Visa/MC path when an FX gap is
// the underlying trigger.
//
// Visa 12.x: 12.3 (Incorrect Currency / Currency Mismatch),
//            12.5 (Incorrect Transaction Amount),
//            12.6.1 (Duplicate Processing),
//            12.6.2 (Paid by Other Means)
// Mastercard 4834: Point-of-Interaction Error (broad processing-error
//                  bucket; FX-gap complaints land here under MC).
const FX_NETWORK_CODES = new Set(['12.3', '12.5', '12.6.1', '12.6.2', '4834']);

function isProcessingErrorCode(dispute) {
  const code = String(dispute?.network_reason_code || '').trim();
  return FX_NETWORK_CODES.has(code);
}

function isForeignCard(charge, account) {
  const issuerCountry = charge?.payment_method_details?.card?.country;
  const expectedCountry = account === 'uk' ? 'GB' : 'US';
  if (!issuerCountry) return { foreign: false, issuerCountry: null, expectedCountry };
  return { foreign: issuerCountry !== expectedCountry, issuerCountry, expectedCountry };
}

// Partial = dispute amount is strictly LESS than the original charge amount.
// A full chargeback (dispute amount == charge amount) is the "I want
// everything back" pattern and is structurally different — not the FX-gap
// shape we're trying to detect.
function isPartialDispute(dispute, charge) {
  const disputeAmount = dispute?.amount;
  const chargeAmount = charge?.amount;
  if (!disputeAmount || !chargeAmount) {
    return { partial: false, ratio: null, disputeAmount, chargeAmount };
  }
  const ratio = disputeAmount / chargeAmount;
  return {
    partial: disputeAmount < chargeAmount,
    ratio,
    disputeAmount,
    chargeAmount,
  };
}

// FX-shaped = the dispute amount is within the range that typical FX gaps
// fall into (3-25% of the charge). Tighter band than "anything less than
// the full charge" — a 1% dispute is probably a tip rounding error, a 50%
// dispute is probably half of a split-cost meal, not an FX miscalc.
//
// Katie Robertson was 11.6% (£60.54 / £520) — solidly in band.
// Range chosen empirically; tune if false-positive cases surface.
const FX_RATIO_MIN = 0.03;
const FX_RATIO_MAX = 0.25;

function isFxShaped(ratio) {
  if (ratio == null) return false;
  return ratio >= FX_RATIO_MIN && ratio <= FX_RATIO_MAX;
}

/**
 * Compute the FX-dispute signature for a dispute. Parallels the
 * stolen-card fraud_signature module structurally.
 *
 * Verdict mapping (3 non-prerequisite signals — same threshold model as
 * fraud_signature so the prompt rules stay symmetric):
 *   - 3 of 3 → STRONG_MATCH  (deterministic CUSTOMER_OUTREACH push)
 *   - 2 of 3 → PARTIAL_MATCH (LLM weighs the hint)
 *   - ≤1 of 3 → NO_MATCH     (normal flow)
 *
 * Charge fetch is best-effort: on failure we degrade to NO_MATCH with
 * `reason` populated so the caller can log it but still proceed.
 */
export async function computeFxDisputeSignature(dispute) {
  const processingErrorCode = isProcessingErrorCode(dispute);

  const base = {
    score: 0,
    signals: {
      processing_error_code: processingErrorCode,
      foreign_card: false,
      partial_dispute: false,
      fx_shaped: false,
    },
    network_reason_code: dispute?.network_reason_code || null,
    account: null,
    issuerCountry: null,
    expectedCountry: null,
    disputeAmount: dispute?.amount || null,
    chargeAmount: null,
    ratio: null,
    reason: null,
  };

  if (!processingErrorCode) {
    return { ...base, verdict: 'NO_MATCH', reason: 'Not a processing-error reason code' };
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
    console.error(`[fx_dispute_signature] Could not fetch charge ${chargeId}: ${err.message}`);
    return { ...base, verdict: 'NO_MATCH', reason: `Charge fetch failed: ${err.message}` };
  }

  const { foreign, issuerCountry, expectedCountry } = isForeignCard(charge, account);
  const { partial, ratio, disputeAmount, chargeAmount } = isPartialDispute(dispute, charge);
  const fxShaped = isFxShaped(ratio);

  const signals = {
    processing_error_code: true,
    foreign_card: foreign,
    partial_dispute: partial,
    fx_shaped: fxShaped,
  };

  const nonPrereqHits = [foreign, partial, fxShaped].filter(Boolean).length;
  let verdict;
  if (nonPrereqHits === 3) verdict = 'STRONG_MATCH';
  else if (nonPrereqHits === 2) verdict = 'PARTIAL_MATCH';
  else verdict = 'NO_MATCH';

  return {
    verdict,
    score: nonPrereqHits,
    signals,
    network_reason_code: dispute.network_reason_code,
    account,
    issuerCountry,
    expectedCountry,
    disputeAmount,
    chargeAmount,
    ratio,
    reason: null,
  };
}
