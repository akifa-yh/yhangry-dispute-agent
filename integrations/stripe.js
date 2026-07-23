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

/**
 * Refund history for a dispute's charge — the refund-crossed-by-dispute
 * signal (source case: Lawrence Suen, 2026-07). When a merchant refund is
 * still PENDING at the moment a chargeback lands, Stripe fails the refund
 * with failure_reason 'charge_for_pending_refund_disputed' — but Stripe
 * already emailed the customer a refund receipt when the refund was CREATED,
 * so the customer often sincerely believes they were refunded when no money
 * ever moved. Downstream consumers: prompt guidance (REFUND-CROSSED-BY-DISPUTE
 * RULES), the Slack ACCEPT banners, and the refund.failed webhook alert.
 *
 * Verdicts:
 *   REFUND_BLOCKED_BY_DISPUTE — a refund failed with charge_for_pending_refund_disputed
 *   REFUND_SETTLED            — a refund actually succeeded (double-credit guard)
 *   REFUND_PENDING            — refund(s) exist, none settled or dispute-blocked
 *   NO_REFUND                 — no refunds on the charge
 * Non-fatal: returns null on any error or missing charge.
 */
export async function getRefundHistoryForDispute(dispute) {
  try {
    const chargeId = typeof dispute?.charge === 'string' ? dispute.charge : dispute?.charge?.id;
    if (!chargeId) return null;
    const { account } = await fetchChargeFromEitherAccount(chargeId);
    const client = account === 'us' ? getStripeUs() : getStripeUk();
    const res = await client.refunds.list({ charge: chargeId, limit: 20 });
    const refunds = (res.data || []).map((r) => ({
      id: r.id,
      amount_cents: r.amount,
      currency: r.currency,
      status: r.status,
      failure_reason: r.failure_reason || null,
      receipt_number: r.receipt_number || null,
      created_iso: r.created ? new Date(r.created * 1000).toISOString() : null,
    }));
    const blockedRefund =
      refunds.find(
        (r) => r.status === 'failed' && r.failure_reason === 'charge_for_pending_refund_disputed'
      ) || null;
    const settledRefund = refunds.find((r) => r.status === 'succeeded') || null;
    // Chronology matters on multi-dispute charges (repeat-disputer pattern):
    // dispute #1 crosses a refund (blocked) → we win → CS issues a NEW refund
    // that settles → customer re-disputes the same charge. For dispute #2 the
    // customer HAS been paid — a settled refund issued AFTER the blocked one
    // must outrank REFUND_BLOCKED_BY_DISPUTE, or the playbook would instruct a
    // double payment. ISO strings compare lexicographically.
    let verdict = 'NO_REFUND';
    if (
      settledRefund &&
      (!blockedRefund ||
        String(settledRefund.created_iso || '') > String(blockedRefund.created_iso || ''))
    ) {
      verdict = 'REFUND_SETTLED';
    } else if (blockedRefund) {
      verdict = 'REFUND_BLOCKED_BY_DISPUTE';
    } else if (refunds.length > 0) {
      verdict = 'REFUND_PENDING';
    }
    return { verdict, refunds, blockedRefund, settledRefund, account };
  } catch (err) {
    console.warn(`[stripe] getRefundHistoryForDispute failed (non-fatal): ${err.message}`);
    return null;
  }
}

/**
 * All disputes on a charge, newest first, from whichever account owns the
 * charge. Used by the refund-failure webhook handler to route its alert into
 * the right dispute's Slack thread. Non-fatal: returns { disputes: [] }.
 */
export async function listDisputesForCharge(chargeId) {
  try {
    if (!chargeId) return { disputes: [], account: null };
    const { account } = await fetchChargeFromEitherAccount(chargeId);
    const client = account === 'us' ? getStripeUs() : getStripeUk();
    const res = await client.disputes.list({ charge: chargeId, limit: 10 });
    const disputes = (res.data || []).sort((a, b) => (b.created || 0) - (a.created || 0));
    return { disputes, account };
  } catch (err) {
    console.warn(`[stripe] listDisputesForCharge failed (non-fatal): ${err.message}`);
    return { disputes: [], account: null };
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

// All open (needs_response) disputes on both accounts with their Stripe
// evidence deadlines, soonest first. Stripe's list API has no status filter,
// so scan the last 120 days and filter client-side — dispute volume is tiny.
// warning_needs_response = pre-chargeback inquiry, still has a due date.
export async function getOpenDisputeDeadlines() {
  const accounts = [
    { name: 'UK', flag: '🇬🇧', client: getStripeUk() },
    { name: 'US', flag: '🇺🇸', client: process.env.STRIPE_SECRET_KEY_US ? getStripeUs() : null },
  ];
  const gte = Math.floor(Date.now() / 1000) - 120 * 24 * 3600;
  const open = [];
  for (const acct of accounts) {
    if (!acct.client) continue;
    let starting_after;
    do {
      const params = { limit: 100, created: { gte } };
      if (starting_after) params.starting_after = starting_after;
      const res = await acct.client.disputes.list(params);
      for (const d of res.data) {
        if (d.status !== 'needs_response' && d.status !== 'warning_needs_response') continue;
        open.push({
          id: d.id,
          account: acct.name,
          flag: acct.flag,
          status: d.status,
          amountDisplay: `${d.currency.toUpperCase()} ${(d.amount / 100).toFixed(2)}`,
          reason: d.network_reason_code || d.reason,
          dueBy: d.evidence_details?.due_by || null,
          hasEvidence: Boolean(d.evidence_details?.has_evidence),
          submissionCount: d.evidence_details?.submission_count ?? 0,
        });
      }
      starting_after = res.has_more ? res.data[res.data.length - 1].id : null;
    } while (starting_after);
  }
  open.sort((a, b) => (a.dueBy ?? Infinity) - (b.dueBy ?? Infinity));
  return open;
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

  // Step 2: Save evidence as a DRAFT on the dispute. submit:false is
  // deliberate — a human reviews the draft in the Stripe dashboard and
  // presses "Submit evidence" there. Stripe does NOT auto-submit drafts,
  // so until that manual step happens the bank has received nothing.
  // Callers must never describe this step as "submitted".
  const updated = await stripeClient.disputes.update(disputeId, {
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
    submit: false,
  });

  console.log(`[stripe] Evidence DRAFT saved (submit=false — needs manual submit in dashboard) for dispute ${disputeId} (${account})`);
  return { account, dueBy: updated.evidence_details?.due_by || null };
}

// ============================================================================
// Weekly / monthly dispute recaps (posted to #y-combinator — Siddz's ask,
// 2026-07-06). Unlike the ratio report these are outcome-aware: new disputes
// in the window, verdicts landed in the window, money still on the line, and
// (monthly) a filed-month cohort table so a dispute filed in April that gets
// decided in June still lives in the April row — it just moves from pending
// to won/lost. All computed live from Stripe at post time; no database.
// ============================================================================

// Statuses where the verdict is still open. Money for these (except
// warning_* inquiries, where no funds have moved yet) is already withheld
// by the bank and comes back only on a win.
const _PENDING_STATUSES = new Set([
  'needs_response',
  'warning_needs_response',
  'under_review',
  'warning_under_review',
]);

async function _listDisputesSince(client, gte) {
  const all = [];
  let starting_after;
  do {
    const params = { limit: 100, created: { gte } };
    if (starting_after) params.starting_after = starting_after;
    const res = await client.disputes.list(params);
    all.push(...res.data);
    starting_after = res.has_more ? res.data[res.data.length - 1].id : null;
  } while (starting_after);
  return all;
}

// Billing name for the disputed charge — makes recap lines recognisable
// ("$364 · product_not_received · Maddie Fuhrman"). Best-effort: a recap
// must never fail because one charge lookup did.
async function _disputeCustomerName(client, dispute) {
  try {
    const ch = await client.charges.retrieve(dispute.charge);
    return ch.billing_details?.name || ch.billing_details?.email || null;
  } catch {
    return null;
  }
}

// Final statuses a dispute can close with. warning_closed = inquiry
// resolved without ever becoming a chargeback (money never moved);
// charge_refunded = we refunded to end it (the accept-inside-EFW-window
// playbook). Buckets must be exhaustive so cohort columns sum to "Filed".
const _FINAL_STATUSES = new Set(['won', 'lost', 'charge_refunded', 'warning_closed']);
const _isWonOutcome = (d) => d.status === 'won' || d.status === 'warning_closed';
const _isLostOutcome = (d) => d.status === 'lost' || d.status === 'charge_refunded';

// FALLBACK source for "verdicts landed in window": the events API
// (charge.dispute.closed). Stripe only retains events ~30 days, so a
// 31-day monthly window can silently miss day-one verdicts — which is why
// the dispute.closed webhook stamps metadata.closed_at (durable) and that
// stamp is preferred whenever present. This path only covers disputes
// closed before stamping shipped (2026-07-07).
async function _decidedInWindow(client, gte, lt) {
  const decided = [];
  let starting_after;
  do {
    const params = { limit: 100, type: 'charge.dispute.closed', created: { gte, lt } };
    if (starting_after) params.starting_after = starting_after;
    const res = await client.events.list(params);
    for (const ev of res.data) {
      const d = ev.data?.object;
      if (d) decided.push(d);
    }
    starting_after = res.has_more ? res.data[res.data.length - 1].id : null;
  } while (starting_after);
  return decided;
}

function _sumAmount(disputes) {
  return disputes.reduce((s, d) => s + (d.amount || 0), 0);
}

// Non-refundable Stripe dispute fees actually charged, straight from the
// balance transactions (fee is paid even on a win).
function _sumFees(disputes) {
  return disputes.reduce(
    (s, d) => s + (d.balance_transactions || []).reduce((t, tx) => t + (tx.fee || 0), 0),
    0
  );
}

// Recap for one account. `windowGte`/`windowLt` bound "new" and "decided";
// `cohortGte` bounds the monthly cohort table (null for the weekly recap).
async function _recapForAccount(client, { windowGte, windowLt, cohortGte }) {
  // Open-dispute scan always looks back a full year even when the cohort
  // table only needs 6 months — otherwise a still-pending 7-month-old
  // dispute would show in the weekly "awaiting verdict" total but vanish
  // from the monthly one, and the two reports would contradict each other.
  const scanGte = Math.min(cohortGte ?? Infinity, windowGte - 365 * 24 * 3600);
  const [allDisputes, decidedRaw] = await Promise.all([
    _listDisputesSince(client, Math.min(scanGte, windowGte)),
    _decidedInWindow(client, windowGte, windowLt),
  ]);

  const currency = allDisputes[0]?.currency || decidedRaw[0]?.currency || null;

  const newDisputes = [];
  for (const d of allDisputes) {
    if (d.created < windowGte || d.created >= windowLt) continue;
    newDisputes.push({
      id: d.id,
      amount: d.amount,
      currency: d.currency,
      reason: d.network_reason_code || d.reason,
      name: await _disputeCustomerName(client, d),
    });
  }

  // Verdicts landed in the window. Primary source: the metadata.closed_at
  // stamp written by the dispute.closed webhook (durable, exact). Fallback:
  // charge.dispute.closed events, for disputes closed before stamping
  // shipped. A stamped dispute is never double-counted from the event
  // stream — the stamp is authoritative for which window it belongs to.
  const decidedMap = new Map();
  for (const d of allDisputes) {
    const ts = Number(d.metadata?.closed_at || 0);
    if (ts >= windowGte && ts < windowLt && _FINAL_STATUSES.has(d.status)) {
      decidedMap.set(d.id, d);
    }
  }
  const stamped = new Set(allDisputes.filter((d) => d.metadata?.closed_at).map((d) => d.id));
  for (const d of decidedRaw) {
    if (stamped.has(d.id) || decidedMap.has(d.id)) continue;
    if (_FINAL_STATUSES.has(d.status)) decidedMap.set(d.id, d);
  }
  const decided = [];
  for (const d of decidedMap.values()) {
    decided.push({
      id: d.id,
      status: d.status,
      amount: d.amount,
      currency: d.currency,
      name: await _disputeCustomerName(client, d),
    });
  }

  const open = allDisputes.filter((d) => _PENDING_STATUSES.has(d.status));

  const recap = {
    currency,
    newDisputes,
    newAmount: _sumAmount(newDisputes.map((n) => ({ amount: n.amount }))),
    decided,
    won: decided.filter(_isWonOutcome),
    lost: decided.filter(_isLostOutcome),
    openCount: open.length,
    openAmount: _sumAmount(open),
  };

  if (cohortGte != null) {
    // Filed-month cohorts with status as of right now. Keyed "YYYY-MM" (UTC).
    // Every month in the range gets a row up front, including zero-dispute
    // months — a visible zero is information, a missing row looks like a bug.
    const byMonth = new Map();
    const start = new Date(cohortGte * 1000);
    for (
      let y = start.getUTCFullYear(), m = start.getUTCMonth();
      Date.UTC(y, m, 1) / 1000 < windowLt;
      m === 11 ? (y++, (m = 0)) : m++
    ) {
      byMonth.set(`${y}-${String(m + 1).padStart(2, '0')}`, []);
    }
    for (const d of allDisputes) {
      // Upper bound matters: a dispute filed after month-end but before the
      // cron fires would otherwise leak a partial current-month row into
      // the table and the scorecard.
      if (d.created < cohortGte || d.created >= windowLt) continue;
      const dt = new Date(d.created * 1000);
      const key = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
      if (!byMonth.has(key)) byMonth.set(key, []);
      byMonth.get(key).push(d);
    }
    recap.cohorts = [...byMonth.keys()].sort().map((key) => {
      const ds = byMonth.get(key);
      const won = ds.filter(_isWonOutcome);
      const lost = ds.filter(_isLostOutcome);
      // Remainder, not a status allowlist — guarantees Won+Lost+Pending
      // always sums to Filed even if Stripe grows a new status.
      const pending = ds.filter((d) => !_isWonOutcome(d) && !_isLostOutcome(d));
      return {
        month: key,
        filed: ds.length,
        filedAmount: _sumAmount(ds),
        won: won.length,
        wonAmount: _sumAmount(won),
        lost: lost.length,
        lostAmount: _sumAmount(lost),
        pending: pending.length,
        pendingAmount: _sumAmount(pending),
      };
    });
    const cohortDisputes = [...byMonth.values()].flat();
    recap.scorecard = {
      decided: cohortDisputes.filter((d) => _isWonOutcome(d) || _isLostOutcome(d)).length,
      won: cohortDisputes.filter(_isWonOutcome).length,
      wonAmount: _sumAmount(cohortDisputes.filter(_isWonOutcome)),
      lostAmount: _sumAmount(cohortDisputes.filter(_isLostOutcome)),
      feesPaid: _sumFees(cohortDisputes),
    };
  }

  return recap;
}

// kind: 'weekly' = trailing 7 days ending now (run Monday morning → covers
// Mon–Sun). 'monthly' = the most-recently-completed calendar month, plus a
// 6-month cohort table. Both accounts, US first (it carries the volume).
export async function getDisputeRecap(kind, now = new Date()) {
  const nowSec = Math.floor(now.getTime() / 1000);
  let windowGte, windowLt, cohortGte = null, periodLabel;

  if (kind === 'weekly') {
    windowLt = nowSec;
    windowGte = nowSec - 7 * 24 * 3600;
    const fmt = (s) => {
      const d = new Date(s * 1000);
      return `${d.getUTCDate()} ${_MONTHS[d.getUTCMonth()].slice(0, 3)}`;
    };
    periodLabel = `${fmt(windowGte)} – ${fmt(windowLt - 1)}`;
  } else {
    const y = now.getUTCFullYear(), m = now.getUTCMonth();
    windowGte = Math.floor(Date.UTC(y, m - 1, 1) / 1000);
    windowLt = Math.floor(Date.UTC(y, m, 1) / 1000);
    cohortGte = Math.floor(Date.UTC(y, m - 6, 1) / 1000);
    const rm = new Date(windowGte * 1000);
    periodLabel = `${_MONTHS[rm.getUTCMonth()]} ${rm.getUTCFullYear()}`;
  }

  const defs = [
    { name: 'US', flag: '🇺🇸', currency: 'usd', client: process.env.STRIPE_SECRET_KEY_US ? getStripeUs() : null },
    { name: 'UK', flag: '🇬🇧', currency: 'gbp', client: process.env.STRIPE_SECRET_KEY ? getStripeUk() : null },
  ];
  const accounts = [];
  for (const def of defs) {
    if (!def.client) continue;
    const recap = await _recapForAccount(def.client, { windowGte, windowLt, cohortGte });
    // A quiet account has no disputes to infer its currency from.
    recap.currency = recap.currency || def.currency;
    accounts.push({ name: def.name, flag: def.flag, ...recap });
  }
  return { kind, periodLabel, accounts };
}
