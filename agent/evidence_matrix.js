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
 *   network          'visa' | 'mastercard' | 'amex'
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
 *   payment_receipt                   (receipt/charge record in merchant currency)
 *   currency_disclosure_at_checkout   (proof customer saw merchant-currency price pre-payment)
 *   customer_admission                (written cardholder admission the dispute was filed in error)
 *   credit_voucher_record             (platform voucher / account-credit record showing a promised credit is live + unredeemed)
 *   customer_agreed_remedy            (cardholder's written acceptance of a specific remedy, e.g. account credit in lieu of a card refund)
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
 *   2026-05-14 — added Visa 12.3 / 12.5 / 12.6.1 / 12.6.2 processing-error
 *                codes (Tyler retro #9). Katie Robertson case (2026-05-02)
 *                was a Visa 12.5 that fell back to general rules — agent
 *                suggested a chef-attendance/deadline rebuttal which is
 *                irrelevant for a currency-conversion dispute. New
 *                canonical types: payment_receipt,
 *                currency_disclosure_at_checkout, customer_admission.
 *   2026-06-24 — added American Express codes (C02 credit-not-processed,
 *                C08 not-received, C31 not-as-described, C05 cancelled,
 *                F29 card-not-present fraud) + amex network inference in
 *                lookupMatrixEntry. Khushbu Aggarwal C02 (2026-06) fell back
 *                to general rules because no Amex entry existed. New canonical
 *                types: credit_voucher_record, customer_agreed_remedy. C02
 *                encodes the "credit WAS processed + customer agreed to the
 *                remedy" win path (the Khushbu double-dip re-dispute lesson).
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

// ----------------------------------------------------------------------------
// VISA 12.x — PROCESSING ERROR CODES
// ----------------------------------------------------------------------------
// 12.x disputes are about HOW the transaction was processed (wrong amount,
// wrong currency, duplicate, paid by other means) — NOT about service quality
// or attendance. The rebuttal playbook is fundamentally different from 13.x:
//   - DO NOT lead with chef attendance (irrelevant)
//   - DO NOT lead with the complaint deadline (disputes can be filed pre-event)
//   - DO lead with: amount/currency authorised at checkout = amount/currency charged
//   - DO frame any cardholder-statement discrepancy as issuer-side FX conversion
//   - DO surface customer_admission emails (when present) as the BOTTOM LINE

const visa_12_3 = {
  network: 'visa',
  reason_code: '12.3',
  label: 'Processing Error — Incorrect Currency',
  description:
    "Cardholder claims the transaction was processed in the wrong currency. For yhangry this is rare — pricing is consistently GBP for UK bookings and USD for US bookings — but can arise when a customer expected one currency and was charged in another. Counter-evidence focuses on showing the agreed-upon currency was disclosed at checkout and matches the charged currency.",

  common_claims: [
    'charged_in_wrong_currency',
    'currency_misrepresentation_at_checkout',
    'expected_different_currency',
  ],

  required_evidence: [
    'payment_receipt',
    'agreed_service_description',
    'currency_disclosure_at_checkout',
  ],

  strengthening_evidence: [
    'customer_initiated_booking_proof',
    'customer_admission',
  ],

  yhangry_evidence_sources: {
    payment_receipt:
      'Stripe charge record + yhangry receipt showing the exact amount and currency authorised. ALWAYS include for 12.x codes.',
    agreed_service_description:
      'Booking confirmation email showing the price in the merchant\'s billing currency. ALWAYS include for 12.x codes.',
    currency_disclosure_at_checkout:
      'The yhangry checkout requires acceptance of the booking terms before payment (assets/checkout-terms-acceptance.jpeg, the same terms-acceptance asset used for 13.x click-to-accept); those terms bind the customer to the merchant-currency price. The exact per-booking amount and currency are evidenced by payment_receipt + the booking confirmation above — lead the currency-match argument with those, not the checkout image.',
    customer_initiated_booking_proof:
      'Platform messages from customer engaging with the booking before payment.',
    customer_admission:
      'Email correspondence (from info@yhangry.com inbox) where the customer acknowledges the confusion. STRONGEST possible evidence for 12.x — surface in the merchant response callout.',
  },

  notes:
    'Rare for yhangry. NEVER lead with the deadline argument or chef attendance — this is a pricing/currency dispute, not service or timing. Focus rebuttal on: (1) the currency disclosed at checkout matches the currency charged; (2) any difference the cardholder sees on their statement is the issuer\'s FX conversion to their home currency, which is a bank-side action not a merchant pricing decision.',
};

const visa_12_5 = {
  network: 'visa',
  reason_code: '12.5',
  label: 'Processing Error — Incorrect Amount',
  description:
    "Cardholder claims the merchant charged an incorrect amount. For yhangry this typically arises from currency-conversion confusion: customer pays an invoice in GBP, sees the post-conversion USD/EUR amount on their bank statement, and disputes the difference. The merchant's job is to show the amount authorised at checkout matches the amount charged in the merchant's billing currency, and any inter-currency discrepancy is the issuer's FX conversion (not merchant pricing).",

  common_claims: [
    'amount_charged_does_not_match_authorization',
    'currency_conversion_dispute',
    'pricing_misunderstanding',
    'unexpected_statement_amount',
  ],

  required_evidence: [
    'payment_receipt',
    'agreed_service_description',
    'currency_disclosure_at_checkout',
  ],

  strengthening_evidence: [
    'customer_initiated_booking_proof',
    'customer_admission',
  ],

  yhangry_evidence_sources: {
    payment_receipt:
      'yhangry receipt + Stripe charge record showing the exact amount in merchant currency (e.g. £520.00 GBP) authorised and charged. ALWAYS include.',
    agreed_service_description:
      'Booking confirmation email showing "Total cost" and "Amount paid" in merchant currency. ALWAYS include.',
    currency_disclosure_at_checkout:
      'The yhangry checkout requires acceptance of the booking terms before payment (assets/checkout-terms-acceptance.jpeg); the exact merchant-currency amount is shown in payment_receipt + the booking confirmation above — lead the currency-match argument with those.',
    customer_initiated_booking_proof:
      'Platform messages from customer pre-payment showing engagement with the booking.',
    customer_admission:
      'Email correspondence where THIS cardholder acknowledges the dispute was filed in error (e.g. a written commitment to cancel/withdraw it). STRONGEST possible evidence WHEN IT EXISTS — check the correspondence; if present, lead with it in the merchant response callout. Do not assume one exists: many 12.5 cases have no admission.',
  },

  notes:
    'Typical yhangry 12.5 pattern (seen in a 2026-05 case): customer pays in merchant currency, sees a different figure on their statement after the issuer\'s FX conversion, and files 12.5 believing they were overcharged; correspondence sometimes reveals a conversion mix-up the customer acknowledges in writing. RULES FOR 12.5 REBUTTALS: (1) NEVER lead with chef attendance — irrelevant, this is pricing not service. (2) NEVER lead with the complaint deadline — disputes can be filed pre-event for 12.x; the deadline argument doesn\'t bind. (3) LEAD with: "merchant-currency authorised = merchant-currency charged, no discrepancy". (4) Frame the cardholder\'s statement-currency value as the ISSUER\'s FX conversion (the issuer converts at its own rate; the merchant does not control this). (5) If a customer_admission email exists in THIS case, that\'s dispositive — surface it as the BOTTOM-LINE callout in the PDF.',
};

const visa_12_6_1 = {
  network: 'visa',
  reason_code: '12.6.1',
  label: 'Processing Error — Duplicate Processing',
  description:
    "Cardholder claims the same transaction was processed more than once. For yhangry this is rare but can arise during checkout retries or payment-method swaps. Counter-evidence focuses on showing only one charge was authorised for the disputed booking, or — if a true duplicate exists — that it was already refunded.",

  common_claims: [
    'transaction_charged_twice',
    'duplicate_charge_for_same_booking',
  ],

  required_evidence: [
    'payment_receipt',
    'agreed_service_description',
    'refund_processed_proof', // OR proof no duplicate exists; one of the two
  ],

  strengthening_evidence: [
    'customer_admission',
  ],

  yhangry_evidence_sources: {
    payment_receipt:
      'Single Stripe charge record for the disputed booking. If a true duplicate exists, include both charge records + the refund record for the duplicate.',
    agreed_service_description:
      'Booking confirmation referencing the single disputed charge.',
    refund_processed_proof:
      'Stripe refund record for any duplicate charge that was already processed. If no duplicate exists, this field is N/A and the receipt alone is sufficient.',
    customer_admission:
      'Email correspondence where the customer acknowledges the dispute was filed in error (e.g. "I found the other charge was actually a different booking").',
  },

  notes:
    "Verify in Stripe whether a true duplicate charge exists before submitting. If only one charge exists, the rebuttal is clean (single payment_receipt + booking confirmation). If a duplicate does exist, include the refund_processed_proof — the dispute should resolve as a refund-already-processed case rather than going to arbitration.",
};

const visa_12_6_2 = {
  network: 'visa',
  reason_code: '12.6.2',
  label: 'Processing Error — Paid by Other Means',
  description:
    "Cardholder claims they paid for the goods/services by a different method (e.g. bank transfer, cash, different card) but were also charged on the disputed card. Counter-evidence focuses on showing no alternative payment was received by the merchant for this booking.",

  common_claims: [
    'already_paid_by_other_means',
    'paid_in_cash_or_bank_transfer_for_same_booking',
  ],

  required_evidence: [
    'payment_receipt',
    'agreed_service_description',
  ],

  strengthening_evidence: [
    'customer_admission',
    'cancellation_policy_disclosure', // T&Cs typically forbid off-platform payment
  ],

  yhangry_evidence_sources: {
    payment_receipt:
      'Stripe charge record for the disputed booking. Verify with ops that no parallel payment (bank transfer, cash, second card) was received.',
    agreed_service_description:
      'Booking confirmation showing the card payment as the agreed payment method.',
    customer_admission:
      'Email correspondence where the customer acknowledges they did not in fact pay through another method.',
    cancellation_policy_disclosure:
      'yhangry T&Cs at yhangry.com/booking-terms require all payments on-platform — important context if the customer claims off-platform payment.',
  },

  notes:
    "Before submitting, verify with ops that no parallel payment was received for this booking. CHECK this booking's actual confirmation email for the off-platform-payment warning (recent templates include wording like 'Our protection policies do not cover you if payments are made off platform') — IF this customer's email contains it, it is useful counter-evidence against an off-platform-payment claim; do not assert it without checking the sent email.",
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
    "Cardholder claims the goods or services received did not match what was described or were of unacceptable quality. For private chef bookings, this is the most common dispute category — covers missing courses, substitutions, chef leaving early, food quality complaints, etc. Source case for this playbook: Tyler Nader.",

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
      'Per-user timestamped click-to-accept is not yet captured on the booking record (KP product work pending). The agent auto-embeds the yhangry checkout terms-acceptance screenshot (assets/checkout-terms-acceptance.jpeg) as a dedicated page in the evidence PDF for this code, demonstrating that booking terms, privacy policy, and stored-payment authorisation are surfaced and acceptance is required before payment can complete.',
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
    'BIGGEST yhangry FAILURE MODE — lesson from the Tyler past case, which we lost primarily because: (1) no click-to-accept timestamp evidence (bank stated "click-to-accept on cancellation policy not demonstrated"), (2) no real photographic proof of service delivery (chef payout photo was generic stock-style and we did not include even the generic checkout screenshot), (3) the customer\'s "abandoned dessert" allegation went unaddressed. The two biggest leverable wins for 13.3 going forward: (a) include the checkout flow screenshot in EVERY 13.3 pack (default, not optional), (b) for any case where the chef has admitted in writing to substitutions/early-leave/etc., that admission goes to evidence_weaknesses NOT evidence_to_include — banks read these as own-goal corroboration of the customer\'s claim.',
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
// AMERICAN EXPRESS CODES
// ============================================================================
// Amex uses letter-prefixed codes (C##, F##). Stripe surfaces them in
// dispute.network_reason_code (e.g. 'C02') and maps them to a normalised
// dispute.reason (e.g. 'credit_not_processed'). Amex is its own issuer so
// cases can resolve faster, but the evidence bar is the same. yhangry sees
// Amex disputes mostly on US bookings (Amex US consumer cards).

const amex_C02 = {
  network: 'amex',
  reason_code: 'C02',
  label: 'Credit Not Processed',
  description:
    "Amex equivalent of Visa 13.6 / Mastercard 4860 — the cardholder claims a promised credit/refund was never processed. Win paths, depending on THIS case's facts: (a) the promised credit/refund WAS processed and the cardholder agreed to that specific remedy in writing — prove both; (b) no credit was ever promised or owed — prove the absence of any refund commitment; (c) double-dip: goodwill was issued after an earlier dispute on the same payment and the cardholder is re-disputing to collect twice — prove the goodwill and cite the prior dispute. Never re-argue the original service complaint; C02 is about the credit, not the service.",

  common_claims: [
    'credit_promised_but_not_received',
    'partial_refund_disputed',
    'goodwill_credit_not_applied',
    'refund_expected_to_card_received_as_account_credit',
  ],

  required_evidence: [
    'customer_agreed_remedy', // the cardholder accepted this remedy in writing
    'credit_voucher_record', // the credit/voucher exists, is live + unredeemed
    'refund_processed_proof', // any cash refund actually hit the card
  ],

  strengthening_evidence: [
    'payment_receipt',
    'service_delivery_proof',
    'customer_admission',
  ],

  yhangry_evidence_sources: {
    customer_agreed_remedy:
      "Gmail correspondence (info@yhangry.com inbox) where THIS cardholder accepts the remedy in writing (a message specifying the credit/refund they asked for or agreed to). STRONGEST evidence for C02 when it exists: it shows the customer chose that remedy. Quote THIS case's message — never a past case's wording.",
    credit_voucher_record:
      'yhangry admin voucher / account-credit record (Nova) showing the goodwill credit is LIVE, UNREDEEMED, and assigned to THIS customer (pull the actual voucher code, value and redeemed flag from Nova). MUST be live at submission — never revoke the credit mid-dispute, as that makes the "credit not processed" claim literally true.',
    refund_processed_proof:
      "Stripe refund record + the receipt emailed to the customer, plus the Stripe payment activity log entry ('Successfully refunded $X due to customer request'). Stripe's own log is higher-independence than yhangry's confirmation email.",
    payment_receipt:
      'Stripe charge + refund receipt showing the amounts and the card refunded (last4 from THIS charge).',
    service_delivery_proof:
      'chef_submitted_payment_survey + day-of comms — establishes the core service was delivered and only a complimentary/ancillary item was ever in question.',
    customer_admission:
      'Any cardholder email acknowledging the credit was received/agreed. NOTE: an admission about an EARLIER dispute on this payment does NOT count for this one — see the prompt\'s admission time-scope rule.',
  },

  notes:
    'RULES FOR C02: (1) First establish WHICH win path fits THIS case (credit processed & agreed / no credit ever owed / double-dip after goodwill) — do not assume the double-dip pattern; it is one worked example (a 2026-06 case: earlier dispute won, goodwill card refund + account credit accepted in writing, same amount re-disputed as C02), not the definition of C02. (2) Where goodwill/credit exists, LEAD with customer_agreed_remedy + credit_voucher_record + refund_processed_proof — prove the credit was processed and accepted. (3) Do NOT lead with a prior dispute\'s withdrawal admission — that pertained to the earlier dispute (see PRIOR DISPUTES + admission time-scope handling). (4) If a prior dispute on this payment was WON, cite it as a duplicate / second-bite signal. (5) Keep any live credit live through resolution.',
};

const amex_C08 = {
  network: 'amex',
  reason_code: 'C08',
  label: 'Goods/Services Not Received or Only Partially Received',
  description:
    "Amex analogue of Visa 13.1 / Mastercard 4855 — cardholder claims the goods or services were not received. For yhangry: 'the chef never showed up' / 'the booking date passed and nothing happened'. Strongest counter is hard proof of chef attendance and service delivery.",

  common_claims: [
    'chef_did_not_attend',
    'service_never_rendered',
    'no_show',
    'event_date_passed_without_service',
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
    chef_attendance_proof:
      'chef_submitted_payment_survey = true is the STRONGEST signal (chef can only complete it after the job). Also is_chef_ready_response / is_chef_on_time_response.',
    chef_arrival_communication: 'Day-of platform messages from chef (ETA, "arrived").',
    service_delivery_proof: 'See Visa 13.1 caveats — chef payout photos are often weak.',
    post_event_customer_acknowledgment: 'Customer post-event messages, reviews.',
    agreed_service_description: 'Pre-event platform messages.',
  },

  notes:
    'Same playbook as Visa 13.1. Winnable when chef_submitted_payment_survey = true; escalate where the chef genuinely flaked (no survey, no day-of comms).',
};

const amex_C31 = {
  network: 'amex',
  reason_code: 'C31',
  label: 'Goods/Services Not as Described',
  description:
    "Amex analogue of Visa 13.3 — cardholder claims the goods/services received did not match the description (missing courses, substitutions, chef left early, quality complaints). yhangry's most common substantive complaint category; the Tyler lessons apply.",

  common_claims: [
    'courses_not_served',
    'menu_items_substituted_without_consent',
    'chef_left_early',
    'service_below_advertised_quality',
    'incomplete_service',
  ],

  required_evidence: [
    'agreed_service_description',
    'click_to_accept_timestamp',
    'chef_attendance_proof',
    'service_delivery_proof',
  ],

  strengthening_evidence: [
    'substitution_consent',
    'post_event_customer_acknowledgment',
    'chef_arrival_communication',
    'cancellation_policy_disclosure',
  ],

  yhangry_evidence_sources: {
    agreed_service_description: 'Pre-event platform messages where the menu was proposed and accepted.',
    click_to_accept_timestamp:
      'Per-user timestamp not yet captured — the agent auto-embeds the checkout terms-acceptance screenshot (assets/checkout-terms-acceptance.jpeg), same as Visa 13.3.',
    chef_attendance_proof: 'chef_submitted_payment_survey + day-of comms.',
    service_delivery_proof: 'Same caveats as Visa 13.3 — treat generic chef payout photos as suspect.',
    substitution_consent: 'Same gap as 13.3 — chef-side substitution admissions are NEGATIVE evidence (own-goal).',
    post_event_customer_acknowledgment: 'Customer post-event messages, reviews.',
    chef_arrival_communication: 'Day-of platform messages from chef.',
    cancellation_policy_disclosure: 'yhangry.com/booking-terms',
  },

  notes:
    'Same playbook as Visa 13.3 (see that code\'s past-case lesson). Include the checkout terms-acceptance screenshot by default; route any chef-admitted substitution/early-leave to evidence_weaknesses, not evidence_to_include.',
};

const amex_C05 = {
  network: 'amex',
  reason_code: 'C05',
  label: 'Goods/Services Cancelled',
  description:
    "Amex analogue of Visa 13.7 — cardholder claims they cancelled the booking but were charged anyway, or charged after cancellation. Counter by showing the booking was not actually cancelled, or that the cancellation fell after the no-refund deadline per the agreed T&Cs.",

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
    'chef_attendance_proof',
  ],

  yhangry_evidence_sources: {
    cancellation_policy_disclosure: 'yhangry.com/booking-terms',
    cancellation_timing_record:
      "Booking cancellation timestamp + the customer's cancellation message/email timestamp + the event date (to compute days-before-event).",
    click_to_accept_timestamp: 'Same gap as Visa 13.3 — embed the checkout terms-acceptance screenshot.',
    agreed_service_description: 'Pre-event messages.',
    chef_attendance_proof: 'chef_submitted_payment_survey — proves the booking was honoured despite the alleged cancellation.',
  },

  notes:
    'Same playbook as Visa 13.7. Lead with the cancellation timestamp falling inside the no-refund window + the agreed cancellation policy.',
};

const amex_F29 = {
  network: 'amex',
  reason_code: 'F29',
  label: 'Card Not Present (Fraud)',
  description:
    "Amex card-not-present fraud code (parity with Visa 10.4 / Mastercard 4837) — cardholder claims they did not authorise the card-absent transaction. To win, show the legitimate cardholder initiated and authorised the booking, i.e. it wasn't fraud at all.",

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
      'Stripe charge object — AVS / CVV checks (extractPaymentAuth surfaces these to the agent for the payment-authentication exhibit).',
    customer_initiated_booking_proof:
      "Customer-sent platform messages negotiating menu/details — a fraudster doesn't negotiate over days.",
    agreed_service_description: 'Pre-event platform messages.',
    post_event_customer_acknowledgment: 'Post-event messages, reviews.',
    chef_attendance_proof: 'chef_submitted_payment_survey + arrival comms (service delivered to the address).',
  },

  notes:
    "Same playbook as Visa 10.4. yhangry DOES surface AVS/CVV via extractPaymentAuth — when CVC + postcode passed, that's the strongest single rebuttal to an 'unauthorised' claim. Pair with the customer's own platform engagement.",
};

// ============================================================================
// EXPORT
// ============================================================================

export const EVIDENCE_MATRIX = [
  visa_10_4,
  visa_12_3,
  visa_12_5,
  visa_12_6_1,
  visa_12_6_2,
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
  amex_C02,
  amex_C08,
  amex_C31,
  amex_C05,
  amex_F29,
];

/**
 * Stripe's normalised dispute.reason → the per-network reason_code. Used as a
 * fallback when a dispute has no network_reason_code — common on raw disputes
 * before a VROL upload (the dashboard shows e.g. C02 but the API
 * `network_reason_code` field comes back empty). The network is taken from the
 * card brand on the charge. Khushbu Aggarwal C02: the dispute carried
 * reason='credit_not_processed' + an amex card but no network_reason_code, so
 * the playbook missed on the first pass until this fallback was added.
 */
const STRIPE_REASON_TO_CODE = {
  credit_not_processed: { visa: '13.6', mastercard: '4860', amex: 'C02' },
  product_not_received: { visa: '13.1', mastercard: '4855', amex: 'C08' },
  product_unacceptable: { visa: '13.3', mastercard: '4853', amex: 'C31' },
  subscription_canceled: { visa: '13.7', amex: 'C05' },
  fraudulent: { visa: '10.4', mastercard: '4837', amex: 'F29' },
  unrecognized: { visa: '10.4', mastercard: '4863', amex: 'F29' },
  duplicate: { visa: '12.6.1' },
};

function normaliseNetwork(s) {
  const v = String(s || '').toLowerCase();
  if (/amex|american|express/.test(v)) return 'amex';
  if (/visa/.test(v)) return 'visa';
  if (/master/.test(v)) return 'mastercard';
  return '';
}

/**
 * Look up the matrix entry for a dispute.
 *
 * Primary path: resolve by network_reason_code. Network is taken from the
 * explicit `network`, else the `card_brand`, else inferred from the code prefix
 * ('13.x'/'10.x'/'12.x' → visa, '4xxx' → mastercard, 'C##'/'F##' → amex).
 *
 * Fallback path: when there is no usable network_reason_code, map Stripe's
 * normalised `stripe_reason` to the per-network code using `card_brand` for the
 * network. Returns null if neither path resolves — caller handles the
 * "no playbook yet" case (ESCALATE + flag).
 */
export function lookupMatrixEntry({ network, reason_code, stripe_reason, card_brand } = {}) {
  const inferredNetwork = normaliseNetwork(network) || normaliseNetwork(card_brand);

  // Primary — by network reason code.
  if (reason_code) {
    const code = String(reason_code).trim();
    let net = inferredNetwork;
    if (!net) {
      if (/^\d{2}\.\d/.test(code)) net = 'visa';
      else if (/^4\d{3}$/.test(code)) net = 'mastercard';
      else if (/^[A-Z]\d{2}$/.test(code)) net = 'amex'; // Amex C##/F## (e.g. C02, F29)
    }
    const hit = EVIDENCE_MATRIX.find((e) => e.network === net && e.reason_code === code);
    if (hit) return hit;
  }

  // Fallback — by Stripe normalised reason + card brand (no network_reason_code).
  if (stripe_reason && inferredNetwork) {
    const code = STRIPE_REASON_TO_CODE[String(stripe_reason).trim()]?.[inferredNetwork];
    if (code) {
      return (
        EVIDENCE_MATRIX.find(
          (e) => e.network === inferredNetwork && e.reason_code === code
        ) || null
      );
    }
  }

  return null;
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
