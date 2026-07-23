# Archetype: refund crossed by dispute (customer falsely believes they were refunded)

**Source case:** Lawrence Suen — Visa 13.1, $936.00, chef no-show 8 Jul 2026 (booking #177321,
dispute `du_1TrTrJBwio2AEm6ZP39f2Yu9`). Trained 2026-07-24.

## The pattern

1. Merchant-fault non-delivery (chef no-show). Customer files a chargeback with their bank —
   often the same night, **before** contacting us.
2. CS issues a full refund the next day. Stripe **emails the customer a refund receipt at
   creation time**.
3. The chargeback processes hours later, while the refund is still pending → the refund
   **fails** with `failure_reason: charge_for_pending_refund_disputed`. Stripe does not email
   the customer about the failure. A failed refund can **never** resume.
4. The customer, holding a genuine-looking receipt, believes they were refunded. In the source
   case the customer uploaded our receipt to their bank to "stop the dispute" and told them
   *"they don't have to give me credit anymore"* — so the bank **removed his provisional
   credit**, leaving the customer with neither the refund (failed) nor the credit (stripped),
   while the chargeback still held our funds. Nobody had paid the customer, and he didn't know.

## What the agent now does

- **Deterministic signal** (`getRefundHistoryForDispute`, integrations/stripe.js): refund list
  on the disputed charge → verdict `REFUND_BLOCKED_BY_DISPUTE` / `REFUND_SETTLED` /
  `REFUND_PENDING` / `NO_REFUND`. Computed in `analyseDispute` (step 5g), passed to the prompt
  (`REFUND HISTORY ON THIS CHARGE` section), stashed as `analysis._refund_signature`, and adds
  a deterministic ops flag when blocked.
- **Prompt rules** (`REFUND-CROSSED-BY-DISPUTE RULES`, agent/prompt.js): never claim the refund
  completed; corrective email is mandatory; on merchant-fault non-delivery, recommendation
  stays ACCEPT but the reasoning must state the preferred endgame — collect the customer's
  **written** withdrawal confirmation, then counter with "cardholder withdrew" + the
  failed-refund record, so funds return and a NEW refund pays the customer directly.
- **Slack banner add-on** (agent/decision.js): the non-performance and generic ACCEPT banners
  carry the corrective-email + written-withdrawal + exactly-one-payment playbook — only when
  the signature actually fired (template-honesty).
- **Real-time alert** (server.js `handleRefundFailed`): `refund.failed` / `refund.updated` /
  `charge.refund.updated` events with the dispute-crossed failure reason post an alert into
  the dispute's Slack thread. ⚠️ Requires those event types to be enabled on the Stripe
  webhook endpoint config for BOTH accounts (UK + US).
- **Outcome follow-up** (server.js `handleDisputeClosed`): WON → "issue a NEW refund now,
  confirm it settles"; LOST → "do NOT refund again; verify the issuer actually credits the
  customer; watch for a late reversal."

## The rules in one line each

- A failed refund never resumes; only a NEW refund after a favourable close pays the customer.
- The customer's refund receipt ≠ money moved. Correct their record immediately, in writing.
- Written withdrawal + failed-refund proof beats a plain accept when the customer cooperates
  (plain accept relies on the issuer re-crediting a cardholder who told them "already refunded").
- Exactly ONE payment ever: lost/accepted → issuer pays them; won → we pay them.
