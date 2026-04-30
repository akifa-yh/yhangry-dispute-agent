/**
 * EVIDENCE REQUIREMENTS MATRIX
 *
 * For each (network, reason_code) pair we encode the evidence types that
 * actually win at the bank for that dispute category. The agent uses this
 * to score "what we have" vs "what we'd need", flag missing required
 * evidence, and surface code-specific rebuttal levers.
 *
 * SOURCES
 * - Stripe Disputes & Chargebacks docs (https://docs.stripe.com/disputes)
 * - Visa Resolve Online (VROL) reason code reference
 * - Mastercard Chargeback Guide
 * - yhangry's own historical loss patterns (Tyler retro, prior cases)
 *
 * STRUCTURE — each entry has:
 *   network          'visa' | 'mastercard'
 *   reason_code      string — the network's code (e.g. '13.3', '4853')
 *   label            short human-readable name
 *   description      one-paragraph plain-English explanation
 *   common_claims    typical cardholder claim patterns under this code
 *   required_evidence    must-haves to credibly counter; missing one is a
 *                        material weakness
 *   strengthening_evidence    nice-to-haves that boost win odds
 *   yhangry_evidence_sources  for each canonical evidence type, where in
 *                             yhangry's data it can be found (so the agent
 *                             knows how to check availability)
 *   notes            yhangry-specific commentary, retro lessons, gotchas
 *
 * CANONICAL EVIDENCE TYPES — used across entries so checks are consistent:
 *   click_to_accept_timestamp
 *   agreed_service_description
 *   chef_attendance_proof
 *   service_delivery_proof
 *   post_event_customer_acknowledgment
 *   chef_arrival_communication
 *   substitution_consent
 *   cancellation_policy_disclosure
 *   refund_policy_disclosure
 *   transaction_authorization_proof  (AVS/CVV/IP match for fraud codes)
 *   customer_initiated_booking_proof  (customer's own platform actions)
 *   refund_processed_proof
 *   cancellation_timing_record
 *
 * CHANGE LOG — keep updated when entries are revised:
 *   2026-04-29 — initial seed (Visa 10.4/13.1/13.3/13.5/13.6/13.7 +
 *                Mastercard 4853/4855/4863). Tyler-retro learnings baked
 *                into 13.3 notes (click-to-accept critical, generic
 *                chef payout photos hurt rather than help).
 *   2026-04-29 — added Mastercard 4837 (no cardholder authorization,
 *                fraud parity with Visa 10.4) and Mastercard 4860
 *                (credit not processed, parity with Visa 13.6).
 *                Tightened 4855 description to "Transaction Did Not
 *                Complete" per Stripe's category mapping
 *                (https://docs.stripe.com/disputes/categories#network-code-map).
 */

// ============================================================================
// VISA CODES
// ============================================================================

const visa_10_4 = {
  network: 'visa',
  reason_code: '10.4',
  label: 'Other Fraud — Card-Absent Environment',
  description:
    "Cardholder claims they did not authorise the transaction and the card was used in a card-not-present environment (e.g. online checkout). To win, the merchant must show evidence the legitimate cardholder did initiate and authorise the booking — i.e. that this wasn't fraud at all.",

  common_claims: [
    'transaction_not_authorised',
    'card_used_without_permission',
    'no_knowledge_of_booking',
  ],

  required_evidence: [
    'transaction_authorization_proof', // AVS/CVV/3DS match at checkout
    'customer_initiated_booking_proof', // customer's own platform actions
  ],

  strengthening_evidence: [
    'agreed_service_description', // back-and-forth on menu shows engagement
    'post_event_customer_acknowledgment', // customer thanked chef = was them
    'chef_attendance_proof', // service was actually delivered to that address
  ],

  yhangry_evidence_sources: {
    transaction_authorization_proof:
      'Stripe charge object — AVS / CVV / 3DS results. We do not currently surface these to the agent.',
    customer_initiated_booking_proof:
      'Platform messages from the customer (sender_role=customer) negotiating menu, asking questions, confirming details — these prove the legitimate user was active in the booking flow.',
    chef_attendance_proof:
      'chef_submitted_payment_survey + chef arrival messages',
    agreed_service_description:
      'Platform messages on/around booking creation showing menu negotiation',
    post_event_customer_acknowledgment:
      'Platform messages from customer post-event, customer reviews, post-event Aircall calls',
  },

  notes:
    'Fraud codes are rare for yhangry but can be devastating when they hit. The strongest counter-evidence is the customer\'s OWN platform engagement before/during/after the booking — a fraudster typically would not engage in detailed menu negotiations. Look for customer-sent messages, profile activity, and post-event acknowledgement. AVS/CVV evidence sits in Stripe but we do not currently pull it into the agent — flag this if a 10.4 comes through.',
};

const visa_13_1 = {
  network: 'visa',
  reason_code: '13.1',
  label: 'Merchandise/Services Not Received',
  description:
    "Cardholder claims they never received the goods or services they paid for. For private chef bookings this typically means 'the chef never showed up' or 'the booking date passed and nothing happened'. The strongest counter is hard proof of service delivery and chef presence at the venue.",

  common_claims: [
    'chef_did_not_attend',
    'service_never_rendered',
    'no_show',
    'event_date_passed_without_service',
  ],

  required_evidence: [
    'chef_attendance_proof',
    'chef_arrival_communication', // day-of messages confirming chef en route / arrived
  ],

  strengthening_evidence: [
    'service_delivery_proof', // photos of plates, event in progress
    'post_event_customer_acknowledgment', // customer messages post-event
    'agreed_service_description',
  ],

  yhangry_evidence_sources: {
    chef_attendance_proof:
      'chef_submitted_payment_survey = true is the STRONGEST signal — chef can only complete this form after the job is finished. Also is_chef_ready_response / is_chef_on_time_response.',
    chef_arrival_communication:
      'Platform messages on event day from chef (sender_role=chef): ETA messages, "I\'m on my way", "running late", "just arrived". GPS check-ins when available.',
    service_delivery_proof:
      'Chef payout photos (BUT — see notes; these often fail the bar). Customer-sent photos in messages.',
    post_event_customer_acknowledgment:
      'Platform messages from customer post-event ("thanks!", "great night", reviews).',
    agreed_service_description:
      'Platform messages around booking creation establishing what was booked.',
  },

  notes:
    '13.1 is usually winnable when chef_submitted_payment_survey = true — that single field is HIGH-independence proof of completion. Pair with day-of arrival comms (MEDIUM independence) for a strong rebuttal. Where the chef DID flake (no survey, no day-of comms), this code is essentially un-counterable and we should ESCALATE.',
};

const visa_13_3 = {
  network: 'visa',
  reason_code: '13.3',
  label: 'Not as Described or Defective Merchandise/Services',
  description:
    "Cardholder claims the goods or services received did not match what was described or were of unacceptable quality. For private chef bookings, this is the most common dispute category — covers missing courses, substitutions, chef leaving early, food quality complaints, etc. This is the Tyler Nader code.",

  common_claims: [
    'courses_not_served',
    'menu_items_substituted_without_consent',
    'chef_left_early',
    'service_below_advertised_quality',
    'incomplete_service',
    'food_quality_unacceptable',
  ],

  required_evidence: [
    'agreed_service_description', // what was the customer told they would receive
    'click_to_accept_timestamp',  // proof customer accepted T&Cs / cancellation policy
    'chef_attendance_proof',      // chef DID turn up
    'service_delivery_proof',     // proof service was actually rendered as agreed
  ],

  strengthening_evidence: [
    'substitution_consent',                // customer agreed to any menu changes in writing
    'post_event_customer_acknowledgment',  // customer thanked chef / left positive review
    'chef_arrival_communication',          // day-of comms showing chef was working
    'cancellation_policy_disclosure',      // T&Cs link in evidence pack
    'refund_policy_disclosure',
  ],

  yhangry_evidence_sources: {
    agreed_service_description:
      'Pre-event platform messages where chef proposed the menu and customer accepted (look for "Your quote has been updated" + "All set!" type pattern).',
    click_to_accept_timestamp:
      'CURRENTLY MISSING — yhangry checkout displays T&Cs above the "Confirm and pay" button but does not capture per-user timestamped acceptance on the booking record. KP has product work to add this. Until then, include the generic checkout screenshot as a partial substitute.',
    chef_attendance_proof:
      'chef_submitted_payment_survey = true (HIGH). is_chef_ready_response / is_chef_on_time_response. Day-of arrival messages from chef.',
    service_delivery_proof:
      'IDEALLY: timestamped event-specific photos with EXIF data preserved, taken on a real phone (not stock-style). Customer thanks/reviews. Currently weak — chef payout photos exist but are often generic stock-style and EXIF-stripped, which HURTS rather than helps (Tyler retro lesson). Treat existing chef payout photos as suspect until photo-spec work lands.',
    substitution_consent:
      'CURRENTLY MISSING — chef substitutions during the event (e.g. "the seafood was not fresh, I substituted X") are typically captured only in the chef\'s after-the-fact email to ops, which is LOW or NEGATIVE independence. The customer\'s consent to the substitution is rarely captured anywhere queryable. Future product work: in-app "substitution requested by chef → customer accepts" flow.',
    post_event_customer_acknowledgment:
      'Platform messages from customer post-event, post-event Aircall calls (with content unverifiable), customer reviews.',
    chef_arrival_communication:
      'Platform messages from chef on event day.',
    cancellation_policy_disclosure:
      'Static T&Cs link: yhangry.com/booking-terms / yhangry.com/complaints',
    refund_policy_disclosure:
      'Static T&Cs link: yhangry.com/booking-terms',
  },

  notes:
    'BIGGEST yhangry FAILURE MODE — this is the Tyler code. We lost Tyler primarily because: (1) no click-to-accept timestamp evidence (bank stated "click-to-accept on cancellation policy not demonstrated"), (2) no real photographic proof of service delivery (chef payout photo was generic stock-style and we did not include even the generic checkout screenshot), (3) the customer\'s "abandoned dessert" allegation went unaddressed. The two biggest leverable wins for 13.3 going forward: (a) include the checkout flow screenshot in EVERY 13.3 pack (default, not optional), (b) for any case where the chef has admitted in writing to substitutions/early-leave/etc., that admission goes to evidence_weaknesses NOT evidence_to_include — banks read these as own-goal corroboration of the customer\'s claim.',
};

const visa_13_5 = {
  network: 'visa',
  reason_code: '13.5',
  label: 'Misrepresentation',
  description:
    "Cardholder claims the merchant misrepresented the goods/services in advertising or sales materials, or that T&Cs were not adequately disclosed. Different from 13.3 (which is about delivery quality) — 13.5 is about whether the original description was accurate or honest.",

  common_claims: [
    'service_misrepresented_in_marketing',
    'pricing_misleading',
    'terms_not_disclosed_at_purchase',
    'chef_qualifications_misrepresented',
  ],

  required_evidence: [
    'agreed_service_description',
    'click_to_accept_timestamp',
    'cancellation_policy_disclosure',
    'refund_policy_disclosure',
  ],

  strengthening_evidence: [
    'post_event_customer_acknowledgment',
    'service_delivery_proof',
  ],

  yhangry_evidence_sources: {
    agreed_service_description:
      'Pre-event platform messages with the menu agreed; chef profile bio at time of booking; quote breakdown.',
    click_to_accept_timestamp:
      'See 13.3 entry — same gap.',
    cancellation_policy_disclosure: 'yhangry.com/booking-terms',
    refund_policy_disclosure: 'yhangry.com/booking-terms',
    post_event_customer_acknowledgment: 'Customer post-event messages, reviews, post-event Aircall calls.',
    service_delivery_proof: 'Same caveats as 13.3.',
  },

  notes:
    'Less common than 13.3 for yhangry. The strongest counter is showing the customer was clearly informed of what they were buying (menu, price breakdown, T&Cs) and that what was delivered matched. Same click-to-accept gap as 13.3 applies here.',
};

const visa_13_6 = {
  network: 'visa',
  reason_code: '13.6',
  label: 'Credit Not Processed',
  description:
    "Cardholder claims they were entitled to a refund (e.g. cancelled within the refund window) but the merchant did not process it. To win, the merchant must show either (a) the refund was actually processed, or (b) the customer was not entitled to a refund per the agreed cancellation policy.",

  common_claims: [
    'refund_promised_but_not_received',
    'cancelled_within_window_no_refund',
    'partial_refund_disputed',
  ],

  required_evidence: [
    'refund_processed_proof',          // OR cancellation_timing_record (one or the other)
    'cancellation_policy_disclosure',
    'click_to_accept_timestamp',       // proof customer agreed to the cancellation policy
  ],

  strengthening_evidence: [
    'cancellation_timing_record',      // when did the customer cancel relative to the deadline
    'agreed_service_description',
  ],

  yhangry_evidence_sources: {
    refund_processed_proof:
      'Stripe refund records on the dispute / charge object. Refund email confirmations.',
    cancellation_policy_disclosure: 'yhangry.com/booking-terms',
    click_to_accept_timestamp:
      'Same gap as 13.3.',
    cancellation_timing_record:
      'Booking cancellation timestamp from BigQuery (orders.cancelled_at or similar). Customer cancellation email/message timestamps from Conduit/platform messages.',
    agreed_service_description: 'Pre-event platform messages.',
  },

  notes:
    'Usually winnable when we have clean cancellation policy + the customer\'s cancellation came after the no-refund deadline. The Becky pattern is in this category but actually classified as 13.3 / product_unacceptable in Stripe — so 13.6 itself is rarer. Watch for cases where ops processed a partial refund but customer disputes the difference.',
};

const visa_13_7 = {
  network: 'visa',
  reason_code: '13.7',
  label: 'Cancelled Merchandise/Services',
  description:
    "Cardholder claims they cancelled the booking but were charged anyway, or charged after cancellation. The merchant must show either the booking was not actually cancelled, or that the cancellation came after the no-refund deadline per the agreed T&Cs.",

  common_claims: [
    'cancelled_but_charged',
    'cancellation_acknowledged_but_charge_remained',
  ],

  required_evidence: [
    'cancellation_policy_disclosure',
    'cancellation_timing_record',
    'click_to_accept_timestamp',
  ],

  strengthening_evidence: [
    'agreed_service_description',
    'chef_attendance_proof', // proves the booking was honored (chef attended despite alleged cancellation)
  ],

  yhangry_evidence_sources: {
    cancellation_policy_disclosure: 'yhangry.com/booking-terms',
    cancellation_timing_record:
      'Booking cancellation timestamp + the customer\'s actual cancellation message/email timestamp + the event date — used to compute days-before-event.',
    click_to_accept_timestamp: 'Same gap as 13.3.',
    agreed_service_description: 'Pre-event messages',
    chef_attendance_proof: 'chef_submitted_payment_survey, day-of comms, etc.',
  },

  notes:
    'Closely resembles the Simon Cullen case (won — see Slack archive). Counter-evidence pattern: customer cancellation message in writing + cancellation timestamp shows it fell within the no-refund window + chef was already actively prepping. The "cardholder confirmed participation = YES" on the questionnaire is a strong signal — surface this when present.',
};

// ============================================================================
// MASTERCARD CODES
// ============================================================================

const mc_4837 = {
  network: 'mastercard',
  reason_code: '4837',
  label: 'No Cardholder Authorization',
  description:
    "Mastercard's fraud-style code — cardholder claims they did not authorise the transaction at all. Closest equivalent to Visa 10.4. To win, the merchant must show evidence the legitimate cardholder did initiate and authorise the booking — i.e. that this wasn't fraud at all.",

  common_claims: [
    'transaction_not_authorised',
    'card_used_without_permission',
    'no_knowledge_of_booking',
  ],

  required_evidence: [
    'transaction_authorization_proof',
    'customer_initiated_booking_proof',
  ],

  strengthening_evidence: [
    'agreed_service_description',
    'post_event_customer_acknowledgment',
    'chef_attendance_proof',
  ],

  yhangry_evidence_sources: {
    transaction_authorization_proof:
      'Stripe charge object — AVS / CVV / 3DS results. We do not currently surface these to the agent.',
    customer_initiated_booking_proof:
      'Platform messages from the customer (sender_role=customer) negotiating menu, asking questions, confirming details — these prove the legitimate user was active in the booking flow.',
    agreed_service_description: 'Pre-event platform messages.',
    post_event_customer_acknowledgment:
      'Platform messages from customer post-event, customer reviews, post-event Aircall calls.',
    chef_attendance_proof: 'chef_submitted_payment_survey + chef arrival messages.',
  },

  notes:
    'Same playbook as Visa 10.4 — fraud counter-evidence is the customer\'s own platform engagement (sent messages, profile activity, multi-day booking-flow involvement). A real fraudster does not negotiate menus over multiple days. AVS/CVV evidence sits in Stripe but we do not currently pull it into the agent — flag this if a 4837 comes through.',
};

const mc_4853 = {
  network: 'mastercard',
  reason_code: '4853',
  label: 'Cardholder Dispute',
  description:
    "Mastercard's catch-all for cardholder service-quality and not-as-described disputes. Closest equivalent to Visa 13.3. Used for missing items, quality issues, partial service, and cancellation disputes (Mastercard does not cleanly separate these the way Visa does).",

  common_claims: [
    'service_not_provided',
    'service_not_as_described',
    'cancelled_but_charged',
    'quality_below_expectations',
  ],

  required_evidence: [
    'agreed_service_description',
    'chef_attendance_proof',
    'service_delivery_proof',
    'cancellation_policy_disclosure',
    'click_to_accept_timestamp',
  ],

  strengthening_evidence: [
    'post_event_customer_acknowledgment',
    'substitution_consent',
    'chef_arrival_communication',
    'cancellation_timing_record',
  ],

  yhangry_evidence_sources: {
    agreed_service_description: 'Pre-event platform messages.',
    chef_attendance_proof: 'chef_submitted_payment_survey + day-of comms.',
    service_delivery_proof: 'Same caveats as Visa 13.3.',
    cancellation_policy_disclosure: 'yhangry.com/booking-terms',
    click_to_accept_timestamp: 'Same gap as 13.3.',
    post_event_customer_acknowledgment: 'Post-event platform messages, reviews, Aircall calls.',
    substitution_consent: 'Same caveat as 13.3.',
    chef_arrival_communication: 'Day-of platform messages from chef.',
    cancellation_timing_record: 'Booking cancellation timestamp.',
  },

  notes:
    'Mastercard\'s reason-code framework is less granular than Visa\'s, so 4853 covers a wider range of customer claims. Lean heavily on the customer-narrative paste flow to figure out what the actual claim is. The Simon Cullen case (won) was 4853 — leveraged customer-confirmed-participation + cancellation policy disclosure as the win pattern.',
};

const mc_4855 = {
  network: 'mastercard',
  reason_code: '4855',
  label: 'Transaction Did Not Complete',
  description:
    "Mastercard's 'Product not received' code — cardholder claims the transaction did not result in the goods or services being delivered. Closest analogue to Visa 13.1, though Mastercard's catch-all 4853 also overlaps for 'goods or services not provided' framings. Same yhangry evidence playbook applies (chef survey + day-of comms).",

  common_claims: [
    'chef_did_not_attend',
    'service_never_rendered',
    'no_show',
  ],

  required_evidence: [
    'chef_attendance_proof',
    'chef_arrival_communication',
  ],

  strengthening_evidence: [
    'service_delivery_proof',
    'post_event_customer_acknowledgment',
    'agreed_service_description',
  ],

  yhangry_evidence_sources: {
    chef_attendance_proof: 'chef_submitted_payment_survey is HIGH-independence proof.',
    chef_arrival_communication: 'Day-of platform messages from chef.',
    service_delivery_proof: 'See 13.3 caveats.',
    post_event_customer_acknowledgment: 'Customer post-event messages and reviews.',
    agreed_service_description: 'Pre-event platform messages.',
  },

  notes:
    'Same playbook as Visa 13.1. Where chef survey is true, this is winnable. Where chef flaked and there\'s no day-of activity from the chef, escalate.',
};

const mc_4860 = {
  network: 'mastercard',
  reason_code: '4860',
  label: 'Credit Not Processed',
  description:
    "Mastercard equivalent of Visa 13.6 — cardholder claims they were entitled to a refund but the merchant did not process it. To win, show either (a) the refund was actually processed, or (b) the customer was not entitled to a refund per the agreed cancellation policy.",

  common_claims: [
    'refund_promised_but_not_received',
    'cancelled_within_window_no_refund',
    'partial_refund_disputed',
  ],

  required_evidence: [
    'refund_processed_proof',
    'cancellation_policy_disclosure',
    'click_to_accept_timestamp',
  ],

  strengthening_evidence: [
    'cancellation_timing_record',
    'agreed_service_description',
  ],

  yhangry_evidence_sources: {
    refund_processed_proof:
      'Stripe refund records on the dispute / charge object. Refund email confirmations from Conduit.',
    cancellation_policy_disclosure: 'yhangry.com/booking-terms',
    click_to_accept_timestamp: 'Same gap as Visa 13.3.',
    cancellation_timing_record:
      'Booking cancellation timestamp from BigQuery + customer\'s actual cancellation message timestamp from Conduit/platform messages.',
    agreed_service_description: 'Pre-event platform messages.',
  },

  notes:
    'Same playbook as Visa 13.6. Watch for cases where ops processed a partial refund but customer disputes the difference — surface both the refund record AND the cancellation policy clause that justified the partial treatment.',
};

const mc_4863 = {
  network: 'mastercard',
  reason_code: '4863',
  label: 'Cardholder Does Not Recognize',
  description:
    "Mastercard fraud-style code — cardholder doesn't recognise the transaction. Often turns out to be a family member booking on a shared card, or the cardholder forgetting they made the booking. Counter-evidence pattern is similar to Visa 10.4 — prove the legitimate cardholder was involved.",

  common_claims: [
    'transaction_not_recognised',
    'do_not_recognise_merchant',
    'card_used_without_knowledge',
  ],

  required_evidence: [
    'transaction_authorization_proof',
    'customer_initiated_booking_proof',
  ],

  strengthening_evidence: [
    'chef_attendance_proof',
    'agreed_service_description',
    'post_event_customer_acknowledgment',
  ],

  yhangry_evidence_sources: {
    transaction_authorization_proof:
      'Stripe charge object (AVS/CVV/3DS results). Currently not pulled into the agent — flag if this code appears.',
    customer_initiated_booking_proof:
      'Customer-sent platform messages, profile activity, multi-day booking-flow engagement.',
    chef_attendance_proof: 'chef_submitted_payment_survey, day-of comms.',
    agreed_service_description: 'Pre-event platform messages.',
    post_event_customer_acknowledgment: 'Post-event platform messages, reviews.',
  },

  notes:
    'Often resolves quickly when the customer remembers / their family member confirms they did make the booking. The strongest counter is the customer\'s OWN platform messages — fraud rarely involves a cardholder typing menu preferences and replying to chef ETA messages.',
};

// ============================================================================
// EXPORT
// ============================================================================

export const EVIDENCE_MATRIX = [
  visa_10_4,
  visa_13_1,
  visa_13_3,
  visa_13_5,
  visa_13_6,
  visa_13_7,
  mc_4837,
  mc_4853,
  mc_4855,
  mc_4860,
  mc_4863,
];

/**
 * Look up the matrix entry for a (network, reason_code) pair.
 * Returns null if no entry exists — caller should handle the "code we don't
 * have a playbook for yet" case (probably ESCALATE + flag for ops review).
 *
 * Network is inferred from reason_code prefix when not explicitly provided:
 *   '13.x' / '10.x' → visa
 *   '4xxx' → mastercard
 */
export function lookupMatrixEntry({ network, reason_code }) {
  if (!reason_code) return null;

  const code = String(reason_code).trim();
  let inferredNetwork = (network || '').toLowerCase();

  if (!inferredNetwork) {
    if (/^\d{2}\.\d/.test(code)) inferredNetwork = 'visa';
    else if (/^4\d{3}$/.test(code)) inferredNetwork = 'mastercard';
  }

  return (
    EVIDENCE_MATRIX.find(
      (e) => e.network === inferredNetwork && e.reason_code === code
    ) || null
  );
}

/**
 * List the canonical evidence types that appear ANYWHERE in the matrix.
 * Useful for sanity-checking that all referenced types are documented.
 */
export function listAllEvidenceTypes() {
  const set = new Set();
  for (const entry of EVIDENCE_MATRIX) {
    for (const t of entry.required_evidence || []) set.add(t);
    for (const t of entry.strengthening_evidence || []) set.add(t);
  }
  return [...set].sort();
}
