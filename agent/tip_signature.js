/**
 * Post-event tip signal (source case: Trey Quan, 2026-07 — Amex C31 where the
 * cardholder disputed the full charge as "not as described" AFTER voluntarily
 * tipping the chef $100).
 *
 * A voluntary tip given on/after the event is strong deemed-acceptance
 * evidence on "not as described" codes (Amex C31 / Visa 13.3): cardholders do
 * not tip for a service they consider not as described. This module covers
 * the DETERMINISTIC source — platform-recorded tip transactions
 * (transactions.type = '10'). Tips paid off-platform don't appear here; the
 * prompt's POST-EVENT TIP rules teach the model to detect those from the
 * cardholder's own written confirmations instead (in the source case the tip
 * was off-platform and confirmed twice in writing).
 *
 * Verdicts:
 *   TIP_AFTER_EVENT        — platform tip recorded on/after the event date
 *   TIP_RECORDED_PRE_EVENT — tip exists but predates the event (proves nothing
 *                            about delivery; must NOT be argued as acceptance)
 *   NO_TIP_RECORDED        — no platform tip rows (off-platform tips possible)
 *
 * Non-fatal: returns null on any error.
 */
import { getTipTransactionsForOrder } from '../integrations/bigquery.js';

export async function computeTipSignature(booking) {
  try {
    const orderId = booking?.order_id;
    const eventDateStr = booking?.event_date?.value || String(booking?.event_date || '');
    if (!orderId || !eventDateStr) return null;

    const rows = await getTipTransactionsForOrder(orderId);
    const tips = (rows || []).map((r) => {
      const createdRaw = r.created_at?.value || r.created_at || null;
      const createdIso = createdRaw ? new Date(createdRaw).toISOString() : null;
      return {
        amount: r.amount != null ? Number(r.amount) : null,
        currency: r.currency || null,
        created_iso: createdIso,
        // Date-only comparison: a tip stamped any time on the event day is
        // treated as on/after the event (tips are added at/after service).
        on_or_after_event: createdIso ? createdIso.slice(0, 10) >= eventDateStr.slice(0, 10) : false,
      };
    });

    let verdict = 'NO_TIP_RECORDED';
    if (tips.some((tp) => tp.on_or_after_event)) verdict = 'TIP_AFTER_EVENT';
    else if (tips.length > 0) verdict = 'TIP_RECORDED_PRE_EVENT';

    return { verdict, tips, event_date: eventDateStr.slice(0, 10) };
  } catch (err) {
    console.warn(`[tip-signature] computeTipSignature failed (non-fatal): ${err.message}`);
    return null;
  }
}
