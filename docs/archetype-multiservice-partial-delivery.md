# Archetype: Multi-service partial delivery

**Source case:** Tatiana Hakim — order #169688, Amex C08, $6,255 of $7,255 (Jun 2026).
Pack submitted 2026-07-08; verdict pending.
**Added:** 2026-07-08. Trains the gap in the agent's 18 Jun provisional analysis,
which was half right (see final section).

## The pattern

ONE payment covers MULTIPLE distinct services/dates (Tatiana: five meal services over
four days, 22 guests, $7,255). The chef **delivers the first service**; the customer
complains about it, then **cancels the remaining services** — often after a written
warning that within-7-day cancellation is non-refundable. The dispute arrives under a
"not received" code (Amex C08 / Visa 13.1 / MC 4855) for **less than the paid amount**,
with the gap roughly equal to the value of the delivered portion.

## Detection signals

- One charge, several distinct services/dates in the booking data.
- At least one service demonstrably delivered (chef attended per day-of messages, or
  the customer's own quality complaint about a meal that happened). A submitted payment
  survey ALONE is a payment claim, NOT delivery proof — chefs are paid for cancelled
  services too; require corroboration that the first service actually took place.
- The customer cancelled the remaining services AFTER the first one.
- Disputed amount < paid amount, gap ≈ the delivered portion's value — **the
  cardholder's own arithmetic is a written admission of receipt** (Tatiana disputed
  $6,255 = total minus $1,000 she self-allocated to the delivered dinner; "we are happy
  to pay for the one dinner service").
- Escalating settlement offers to pay something for the delivered service ($1,000 →
  "10–15 people" → $800) — a VALUE negotiation, not non-receipt.

## Routing

`chef_attendance_assessment = CONFIRMED` (a service genuinely happened —
`EVENT_CANCELLED_BY_CUSTOMER` means the event NEVER happened and must NOT be used),
`multi_service_partial_delivery = true`, `rebuttal_strategy = SERVICE_RENDERED`,
`recommendation = STRONG_COUNTER` (or `COUNTER_WITH_CAVEATS` if the delivered service
is thinly evidenced, no written policy warning preceded the cancellation, or any
cancelled services were 7+ days out at cancellation — the 100% fee clause does not
cover those). This is the ONE exception to the cancelled-case SERVICE_RENDERED bans.

**Who-caused guard:** applies only when the CUSTOMER caused the cancellation of the
remainder. If the CHEF caused it (unilateral date move, baseless add-on fee, refusal
to perform the remaining services), the surcharge-standoff branch B
(`MERCHANT_DECLINED_TO_PERFORM` → ACCEPT) governs the undelivered remainder instead.

## The two-fork narrative

- **Fork (a) — the delivered portion.** Lead with the cardholder's own written
  admissions: the self-excluded amount, the "happy to pay for the one dinner" line, the
  settlement offers. Quote them verbatim.
- **Fork (b) — the cancelled remainder** (what the disputed money actually maps to).
  A customer-cancellation case. **Check the timing per cancelled service:** the 100%
  Cancellation Fee applies only to services within 7 days of the cancellation. Where
  the cancellation fell within that window, after a written policy warning where one
  exists (Tatiana was warned in writing at 8:40am the morning she cancelled, and
  confirmed on-platform next day — "This is correct!"), the amount is the **100%
  Cancellation Fee** under the accepted Booking Terms; services still 7+ days out are
  NOT covered by the fee — flag in `evidence_weaknesses` and downgrade to
  `COUNTER_WITH_CAVEATS`. The chef's
  incurred costs are framed as COST the fee covers — never as "service delivered" for
  the cancelled services. The honesty of fork (b) is what makes fork (a) credible.
- **Payment-withholding admissions:** quote any statement that the dispute was filed as
  leverage — Tatiana agreed in writing (16 Jun) to await our binding decision, filed
  18 Jun, then admitted 19 Jun she filed "to protect myself financially" / did not want
  the payment "to be finalized". That proves a withholding tactic, not non-receipt.
- **Deadline:** do NOT use it when the complaint was timely (Tatiana phoned the morning
  after the dinner) — the deadline argument was deliberately dropped from her pack.

## Evidence set

Cardholder emails (admissions + offers + leverage statements); the written cancellation
warning + on-platform confirmation; `cancellation_policy_disclosure` (Booking Terms
accepted at checkout); chef supplier receipts mapped line-by-line to the agreed menu
(Tatiana: 9 receipts, ~$1,349, 3–7 Jun — 25lb rice, 110+ eggs, 5lb veal for her 13
veal-Milanese covers) with quantity-vs-guest-count math refuting "food for 10, maybe
15". **Practical note:** Stripe's ~4.5MB evidence limit applies to the TOTAL of ALL
files on the dispute, not per file — compress packs (JPEG-encode embedded exhibits).

## What the agent got half-right (18 Jun)

The provisional analysis chose STRONG_COUNTER / SERVICE_RENDERED / attendance CONFIRMED
— correct on Day-1 receipt, but it completely missed the cancellation-fee frame for the
disputed remainder. SERVICE_RENDERED alone invites "fine, but the other four services
never happened". The winning frame is BOTH forks: receipt of the delivered portion (led
by the cardholder's own admissions) PLUS the customer-cancellation / 100% Cancellation
Fee case for the remainder.
