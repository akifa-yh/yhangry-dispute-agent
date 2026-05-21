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
