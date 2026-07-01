# Archetype: Surcharge-standoff / Merchant non-performance

**Source case:** Maddie Fuhrman — booking #160434, conversation 813666 (Jun 2026).
**Added:** 2026-07-02 on branch `training/maddie-surcharge-standoff`.

## The pattern

The chef declines to perform an **already-paid** booking because the customer will not
pay a **new, post-booking add-on fee** (travel / logistics / "venue-change fee").
The customer neither cancelled nor no-showed — the merchant chose not to deliver.

To an issuing bank this is **"services not received."** Our internal
"changes are the chef's discretion / non-refundable within 7 days" policy does **not**
bind the cardholder's bank. It is near-unwinnable → **ACCEPT, never counter.**

This is distinct from the two existing "no service occurred" routes:
- `EVENT_CANCELLED_BY_CUSTOMER` — customer called it off before the event.
- `CUSTOMER_NO_SHOW` — chef travelled and was ready; customer was absent.
- **`MERCHANT_DECLINED_TO_PERFORM`** — chef never travelled; withheld paid service over
  an unagreed surcharge. (**new**)

## Detection (needs the first three)

1. Original booking fully paid (deposit + remainder) for an agreed date/venue/menu.
2. After booking, the chef requested an EXTRA charge on top of the paid price (often an
   "Update booking" / "Charge Customer" edit the customer never paid).
3. Customer did NOT agree to the new fee **and** the chef did not perform.
   **Querying / asking to justify the fee is NON-agreement, not refusal.**

### Aggravators (record in `evidence_weaknesses`)
- The change that triggered the fee was **third-party-forced**, not the customer's choice
  (e.g. the venue host relocated them — "the property is being fumigated so they moved us").
- Surcharge disproportionate to documented cost, or never itemised **to the customer**
  (an itemisation sent only to Yhangry does not count).
- Same-day confirmation ultimatum used to treat silence as grounds not to travel.
- Chef submitted survey / was paid anyway (`chef_pay > 0`, `refunded_amount = 0`) — this
  is our exposure, not a defense.

## Routing

- `chef_attendance_assessment = MERCHANT_DECLINED_TO_PERFORM`
- `rebuttal_strategy = ACCEPT_MERCHANT_NONPERFORMANCE`
- `recommendation = ACCEPT`
- Do NOT use DEADLINE / SERVICE_RENDERED / CUSTOMER_INITIATED / CUSTOMER_NO_SHOW.
- Do NOT attach booking-terms/no-show exhibits (customer didn't cancel or no-show).
- **Never** submit the internal chef↔Yhangry coaching thread as evidence.
- Apply the SAME strategy to both sibling disputes on the booking (deposit + remainder) —
  do not accept one and contest the other.
- Any partial-cost recovery is a goodwill conversation with the customer, not a counter.

## Guardrails this prevents

Without this branch the agent could mis-read "customer changed venue 3× + didn't confirm
by the chef's deadline + chef prepped food + survey submitted" as
`EVENT_CANCELLED_BY_CUSTOMER` (→ CUSTOMER_INITIATED + late-cancellation-fee counter) or a
`CUSTOMER_NO_SHOW` — both losing counters that would also risk exposing internal material.

## Possible follow-up (not built)

A deterministic `surcharge_standoff_signature.js` (mirroring `fx_dispute_signature.js`)
could force the ACCEPT override if this recurs, keyed on: original paid in full + a
post-booking add-on transaction/edit + no customer payment of it + no chef attendance
evidence. Prompt-level detection is v1; revisit if we see repeats.
