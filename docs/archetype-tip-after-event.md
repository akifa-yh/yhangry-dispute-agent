# Archetype: tip-after-event ("not as described" dispute after voluntarily tipping)

**Source case:** Trey Quan — Amex C31, $1,344 full charge, bachelor-party dinner 30 May 2026
(order #170097, dispute `du_1TjtLtBwio2AEm6Z2dAnjYwH`). Trained 2026-07-24 (#33).

## The pattern

1. Service is delivered with genuine but partial quality issues (late arrival, a missed course).
2. The customer **voluntarily tips the chef** at/after the event — in the source case $100,
   paid off-platform and later confirmed by the customer in writing twice (platform message +
   email; CS deliberately obtained the email confirmation for the record).
3. The customer misses the complaint deadline (checkout-accepted Booking Terms: complaints by
   12 PM next day; deemed acceptance after), then negotiates for a partial refund, and when the
   negotiation stalls, files a **full-value** chargeback as settlement leverage.

## Why the tip matters

A voluntary post-event tip is leading deemed-acceptance evidence on "not as described" codes
(Amex C31 / Visa 13.3): cardholders do not voluntarily tip for a service they consider not as
described — and it corroborates the deadline/deemed-acceptance argument rather than replacing it.

## What the agent now does

- **Deterministic signal** (`agent/tip_signature.js` + `getTipTransactionsForOrder`,
  integrations/bigquery.js): platform tip transactions (`transactions.type = '10'`) on the
  booking, compared to the event date. Verdicts: `TIP_AFTER_EVENT` / `TIP_RECORDED_PRE_EVENT` /
  `NO_TIP_RECORDED`. Rendered as the prompt's `TIP / GRATUITY RECORD` section and stashed as
  `analysis._tip_signature`.
- **Written-confirmation detection** (prompt: `POST-EVENT TIP DETECTION & USE`): tips are often
  paid off-platform (the source case's was) — the model detects the cardholder's OWN written
  confirmation in Gmail/platform messages, verbatim-quoted, same standard as admissions.
  Chef-side "they tipped me" claims are not sufficient. New output fields:
  `post_event_tip_detected` / `post_event_tip_evidence` / `post_event_tip_source`.
- **Fabrication guards** (agent/index.js): `_tip_signature` stashed unconditionally; a
  'transactions'-sourced claim the platform record doesn't back is stripped and flagged.
  Pre-event tips are never argued as acceptance.
- **Slack banner** (agent/decision.js): `:gift: POST-EVENT TIP DETECTED` (written confirmation,
  quoted) or `POST-EVENT TIP ON RECORD` (deterministic), calibrated ("strong evidence, not a
  guarantee"), with the pack-sourcing reminder.
- **Evidence matrix** (C31 + 13.3): `post_event_tip` strengthening evidence with source mapping.

## The page-source rule (pack honesty — verified 10 Jul 2026 against the live site)

- The **tip clause** ("…or if you tip the chef, we will be unable to help you with a
  resolution") lives ONLY on the published complaints page (yhangry.com/complaints). Quote it
  verbatim and attribute it there. It is NOT in the checkout Booking Terms — presenting it as
  checkout-accepted would be false and impeachable.
- The **complaint deadline, deemed-acceptance and no-refund-obligation clauses** ARE in the
  checkout-accepted Booking Terms (yhangry.com/booking-terms → RESOLVING ISSUES) — cite those
  as checkout-accepted.

## Source-case honesty guardrails (apply to any case on this archetype)

Never deny documented service failures (the chef apologised in writing for the late arrival);
name missed items accurately (a missed first course is not "a side"); never invent refund
offers; never claim response-time behaviour the record contradicts; leave withdrawn goodwill
offers out of the pack.
