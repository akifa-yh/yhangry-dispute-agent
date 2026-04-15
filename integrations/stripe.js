import Stripe from 'stripe';

// Lazy init — env vars may not be loaded when this module is first imported
let _stripe;
function getStripe() {
  if (!_stripe) _stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  return _stripe;
}

export { getStripe as stripe };

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
