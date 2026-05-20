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

export async function submitEvidence(disputeId, analysis, booking, docxBuffer) {
  // Step 1: Upload docx
  const file = await getStripe().files.create({
    purpose: 'dispute_evidence',
    file: {
      data: docxBuffer,
      name: `dispute-${disputeId}.pdf`,
      type: 'application/pdf',
    },
  });

  console.log(`[stripe] Uploaded evidence file ${file.id} for dispute ${disputeId}`);

  // Step 2: Submit evidence
  await getStripe().disputes.update(disputeId, {
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

  console.log(`[stripe] Evidence submitted (submit=false) for dispute ${disputeId}`);
}
