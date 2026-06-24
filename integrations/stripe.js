import Stripe from 'stripe';

// Lazy init — env vars may not be loaded when this module is first imported.
// yhangry runs two Stripe accounts (UK = STRIPE_SECRET_KEY, US =
// STRIPE_SECRET_KEY_US); both feed disputes into the same webhook endpoint,
// so the agent must be able to talk to either account when fetching charge
// details for fraud-signature checks.
let _stripeUk;
let _stripeUs;
function getStripeUk() {
  if (!_stripeUk) _stripeUk = new Stripe(process.env.STRIPE_SECRET_KEY);
  return _stripeUk;
}
function getStripeUs() {
  if (!_stripeUs) _stripeUs = new Stripe(process.env.STRIPE_SECRET_KEY_US);
  return _stripeUs;
}

// Existing default export — UK client. Existing call sites stay on UK.
export { getStripeUk as stripe };
export { getStripeUs };

// ============================================================================
// Monthly dispute-ratio report (posted to #stripe-disputes on the 1st of each
// month). Ratio = disputes filed ÷ paid charges, per account, per calendar
// month. A dispute counts the moment it is filed regardless of outcome — this
// mirrors how Visa/Mastercard compute the monitoring ratio — so it is
// deliberately outcome-agnostic. Added 2026-06 after the US ratio hit ~1.7%.
// ============================================================================
async function _countDisputes(client, gte, lt) {
  let count = 0, lost = 0, starting_after;
  do {
    const params = { limit: 100, created: { gte, lt } };
    if (starting_after) params.starting_after = starting_after;
    const res = await client.disputes.list(params);
    count += res.data.length;
    lost += res.data.filter((d) => d.status === 'lost').length;
    starting_after = res.has_more ? res.data[res.data.length - 1].id : null;
  } while (starting_after);
  return { count, lost };
}

async function _countPaidCharges(client, gte, lt) {
  let count = 0, starting_after, pages = 0;
  do {
    const params = { limit: 100, created: { gte, lt } };
    if (starting_after) params.starting_after = starting_after;
    const res = await client.charges.list(params);
    count += res.data.filter((c) => c.paid && c.status === 'succeeded').length;
    starting_after = res.has_more ? res.data[res.data.length - 1].id : null;
    if (++pages > 300) break; // safety cap (~30k charges) — far above current volume
  } while (starting_after);
  return count;
}

async function _ratioForWindow(client, gte, lt) {
  const [d, paidCharges] = await Promise.all([
    _countDisputes(client, gte, lt),
    _countPaidCharges(client, gte, lt),
  ]);
  const ratio = paidCharges ? (d.count / paidCharges) * 100 : 0;
  return { disputes: d.count, lost: d.lost, paidCharges, ratio };
}

const _MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Returns the report for the most-recently-completed calendar month (the month
// before `now`), with the prior month included for the trend, both accounts.
export async function getDisputeRatioReport(now = new Date()) {
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  const reportStart = Math.floor(Date.UTC(y, m - 1, 1) / 1000);
  const reportEnd = Math.floor(Date.UTC(y, m, 1) / 1000);
  const priorStart = Math.floor(Date.UTC(y, m - 2, 1) / 1000);
  const rm = new Date(reportStart * 1000);
  const periodLabel = `${_MONTHS[rm.getUTCMonth()]} ${rm.getUTCFullYear()}`;

  const defs = [
    { name: 'US', flag: '🇺🇸', client: process.env.STRIPE_SECRET_KEY_US ? getStripeUs() : null },
    { name: 'UK', flag: '🇬🇧', client: process.env.STRIPE_SECRET_KEY ? getStripeUk() : null },
  ];
  const accounts = [];
  for (const def of defs) {
    if (!def.client) continue;
    const cur = await _ratioForWindow(def.client, reportStart, reportEnd);
    const prev = await _ratioForWindow(def.client, priorStart, reportStart);
    accounts.push({ name: def.name, flag: def.flag, ...cur, priorRatio: prev.ratio });
  }
  return { periodLabel, accounts };
}

// Fetch a charge from whichever account owns it. Tries UK first; on
// resource_missing / 404, retries against US. Returns { charge, account }.
// Throws on any other Stripe error.
export async function fetchChargeFromEitherAccount(chargeId) {
  try {
    const charge = await getStripeUk().charges.retrieve(chargeId);
    return { charge, account: 'uk' };
  } catch (err) {
    const notFound = err?.code === 'resource_missing' || err?.statusCode === 404;
    if (!notFound) throw err;
    const charge = await getStripeUs().charges.retrieve(chargeId);
    return { charge, account: 'us' };
  }
}

// Payment-authentication summary from a charge — feeds the auto "payment
// authentication" exhibit (commit 2026-06-06). When the card's CVC/AVS checks
// passed, that's the strongest single rebuttal to an "unrecognized" /
// "unauthorised" claim: the security code + billing postcode were entered
// correctly and verified by the issuer, i.e. a deliberate, authenticated
// payment. Pure function — given a Stripe charge, returns the fields or null.
export function extractPaymentAuth(charge) {
  const card = charge?.payment_method_details?.card;
  if (!card) return null;
  const checks = card.checks || {};
  const bd = charge.billing_details || {};
  return {
    brand: card.brand || null,                 // 'amex', 'visa', ...
    last4: card.last4 || null,
    country: card.country || null,             // issuer country, e.g. 'US'
    funding: card.funding || null,             // 'credit' | 'debit' | ...
    cvcCheck: checks.cvc_check || null,                       // 'pass' | 'fail' | 'unavailable' | 'unchecked'
    postalCheck: checks.address_postal_code_check || null,
    line1Check: checks.address_line1_check || null,
    ownerName: bd.name || null,
    ownerEmail: bd.email || null,
  };
}

// Fetch the dispute's charge and return its payment-authentication summary.
// Non-fatal: returns null on any error or missing charge.
export async function getPaymentAuthForDispute(dispute) {
  try {
    const chargeId = typeof dispute?.charge === 'string' ? dispute.charge : dispute?.charge?.id;
    if (!chargeId) return null;
    const { charge } = await fetchChargeFromEitherAccount(chargeId);
    return extractPaymentAuth(charge);
  } catch (err) {
    console.warn(`[stripe] getPaymentAuthForDispute failed: ${err.message}`);
    return null;
  }
}

// Fetch a dispute from whichever account owns it. Same dual-account pattern
// as fetchChargeFromEitherAccount. Used by analyseDispute to rehydrate
// dispute objects that arrive from button/modal payloads stripped down to
// { id, payment_intent, amount, reason, network_reason_code } — without
// rehydration `dispute.charge` is undefined, which breaks the booking-lookup
// fallback and the fraud_signature module.
export async function fetchDisputeFromEitherAccount(disputeId) {
  try {
    const dispute = await getStripeUk().disputes.retrieve(disputeId);
    return { dispute, account: 'uk' };
  } catch (err) {
    const notFound = err?.code === 'resource_missing' || err?.statusCode === 404;
    if (!notFound) throw err;
    const dispute = await getStripeUs().disputes.retrieve(disputeId);
    return { dispute, account: 'us' };
  }
}

/**
 * Find OTHER disputes on the same payment (charge). A single charge can be
 * disputed more than once — e.g. a cardholder who loses or withdraws one
 * dispute then re-files under a different reason code. The agent needs to know
 * about siblings so it treats each dispute independently and never reuses a
 * prior dispute's admission/evidence (Khushbu Aggarwal: a won 13.x dispute
 * followed by a C02 'credit not processed' re-dispute on the same payment,
 * du_1Te5Qq..., 2026-06).
 *
 * Returns prior disputes sorted oldest-first, each as
 * { id, reason, network_reason_code, status, amount_cents, currency,
 *   created_iso }. Non-fatal: returns [] on any error or when the charge
 * can't be resolved.
 */
export async function getPriorDisputesForPayment(dispute) {
  try {
    const chargeId =
      typeof dispute?.charge === 'string' ? dispute.charge : dispute?.charge?.id;
    if (!chargeId) return [];
    const { account } = await fetchChargeFromEitherAccount(chargeId);
    const client = account === 'us' ? getStripeUs() : getStripeUk();
    const res = await client.disputes.list({ charge: chargeId, limit: 100 });
    return (res.data || [])
      .filter((d) => d.id !== dispute.id)
      .map((d) => ({
        id: d.id,
        reason: d.reason || null,
        network_reason_code: d.network_reason_code || null,
        status: d.status || null,
        amount_cents: d.amount,
        currency: d.currency,
        created_iso: d.created ? new Date(d.created * 1000).toISOString() : null,
      }))
      .sort((a, b) => new Date(a.created_iso || 0) - new Date(b.created_iso || 0));
  } catch (err) {
    console.warn(`[stripe] getPriorDisputesForPayment failed: ${err.message}`);
    return [];
  }
}

/**
 * Derive a dispute's actual financial outcome from the Stripe API, separate
 * from the dispute.status label.
 *
 * Why this exists: Stripe's `dispute.status` is the FORMAL Visa/Mastercard
 * resolution state. It's the wrong signal for "did yhangry actually lose
 * money?" — for example, customer-initiated bank withdrawals can return
 * funds via a separate balance transaction even while `status === 'lost'`
 * stays put for weeks/months until the formal Visa case closes. Conversely,
 * a "won" dispute can still have an unrecovered fee. Surfaced 2026-05-21
 * after the Katie Robertson Visa 12.5 case (du_1TSbuXJslp99M2l08y417Rqk):
 * Stripe Support told ops "you didn't lose any money" but the formal status
 * stayed "lost", and the dashboard balance vs API balance_transactions
 * disagreed — exactly the kind of ambiguity ops shouldn't have to resolve
 * by hand.
 *
 * What this returns: a structured summary of EVERY balance transaction
 * attached to the dispute, the net cents (sum of `.net`), plus the formal
 * status. Caller can then make an informed call about real-world outcome
 * vs formal status, and surface the difference to ops when they diverge.
 *
 * Caveats — what this does NOT capture:
 *   - Account-level offsetting credits that don't surface as a separate
 *     dispute-attached balance_transaction (Stripe Support has applied
 *     these in the past on Katie's case; not visible via this API path).
 *   - Pending reversals that haven't yet posted as a balance_transaction.
 *   - Re-charges to the customer or off-platform settlements.
 * When the formal status and the net disagree with what ops sees in the
 * dashboard, treat the dashboard as authoritative — this helper is one
 * input, not the final word.
 */
export async function getDisputeFinancialOutcome(disputeId) {
  const { dispute, account } = await fetchDisputeFromEitherAccount(disputeId);
  const txns = dispute.balance_transactions || [];

  const transactions = txns.map((tx) => ({
    id: tx.id,
    type: tx.type,
    reporting_category: tx.reporting_category,
    amount_cents: tx.amount,
    fee_cents: tx.fee,
    net_cents: tx.net,
    currency: tx.currency,
    description: tx.description || null,
    created_iso: tx.created ? new Date(tx.created * 1000).toISOString() : null,
    status: tx.status,
  }));

  const netCents = transactions.reduce((sum, t) => sum + (t.net_cents || 0), 0);

  // Classify the implied financial outcome from the API's view, NOT from
  // the formal status label. Lets callers spot disagreements between the
  // two — which is the whole point of this helper.
  let impliedOutcome;
  if (transactions.length === 0) {
    impliedOutcome = 'no_transactions'; // dispute not yet financially recorded
  } else if (netCents < 0) {
    impliedOutcome = 'merchant_lost'; // funds debited from merchant
  } else if (netCents > 0) {
    impliedOutcome = 'merchant_gained'; // funds returned (rare; usually netCents == 0 on a clean win)
  } else {
    impliedOutcome = 'merchant_neutral'; // initial debit + offsetting credit cleanly zero out
  }

  return {
    disputeId,
    account,
    formalStatus: dispute.status,
    dispute_amount_cents: dispute.amount,
    currency: dispute.currency,
    netCents,
    netDisplay: `${dispute.currency.toUpperCase()} ${(netCents / 100).toFixed(2)}`,
    impliedOutcome,
    transactions,
    statusDisagreesWithApi:
      (dispute.status === 'lost' && netCents >= 0) ||
      (dispute.status === 'won' && netCents < 0),
  };
}

export async function submitEvidence(disputeId, analysis, booking, docxBuffer) {
  // Determine which Stripe account owns this dispute (UK or US). Both the
  // file upload AND the disputes.update must use the same client — file IDs
  // are account-scoped, so uploading to UK then attaching to a US dispute
  // returns 400. Without this routing, submitEvidence silently fails on
  // every US dispute (e.g. du_1TRlR1Bwio2AEm6ZNSo3pckc, May 2026).
  const { account } = await fetchDisputeFromEitherAccount(disputeId);
  const stripeClient = account === 'us' ? getStripeUs() : getStripeUk();
  console.log(`[stripe] submitEvidence routing dispute ${disputeId} via ${account.toUpperCase()} account`);

  // Step 1: Upload docx (file is account-scoped — must match dispute account)
  const file = await stripeClient.files.create({
    purpose: 'dispute_evidence',
    file: {
      data: docxBuffer,
      name: `dispute-${disputeId}.pdf`,
      type: 'application/pdf',
    },
  });

  console.log(`[stripe] Uploaded evidence file ${file.id} for dispute ${disputeId} (${account})`);

  // Step 2: Submit evidence
  await stripeClient.disputes.update(disputeId, {
    evidence: {
      product_description:
        `Private chef dining experience — multi-course meal prepared and served at customer's home. Booking ref: ${booking.order_id}`,
      service_date: booking.event_date,
      cancellation_policy_disclosure:
        `yhangry's complaints policy requires issues to be raised by 12pm on the day following the event. Full policy: yhangry.com/complaints`,
      refund_policy_disclosure: 'yhangry.com/booking-terms',
      uncategorized_text: (analysis.suggested_rebuttal_points || []).join('\n\n'),
      uncategorized_file: file.id,
    },
    submit: false, // Keep false until verified in production
    // TODO: flip to true when ready to go live
  });

  console.log(`[stripe] Evidence submitted (submit=false) for dispute ${disputeId} (${account})`);
}
