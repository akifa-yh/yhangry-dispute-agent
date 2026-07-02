# Archetype: Post-booking late-change / surcharge standoff

**Source case:** Maddie Fuhrman — booking #160434, conversation 813666 (Jun 2026).
**Added:** 2026-07-02. Corrected same day after ops review (Aki): the customer-caused
version is a **COUNTER**, not an accept.

## The pattern

The booking is fully paid, then a **new post-booking add-on fee** (travel / logistics /
"venue-change fee") is raised on top of the paid price, the customer does not pay it,
and the event does not proceed. The outcome depends entirely on **who caused the
non-delivery** — you MUST decide this first.

## The fork

### Branch A — CUSTOMER-CAUSED → COUNTER (the common case; Maddie)
The customer introduced a **within-7-day** change to a confirmed, paid booking
(date / venue / menu) and then declined or failed to confirm the chef's **reasonable**
terms for accommodating it, so the booking as agreed could not go ahead.

- Under yhangry policy, inside the 7-day window a chef may accept a change and charge
  for the extra travel/logistics; if the customer won't meet those terms the chef is not
  obliged to perform and the booking is non-refundable.
- Contractually this is a **customer-side cancellation / failure to complete within the
  7-day window.** Route: `chef_attendance_assessment = EVENT_CANCELLED_BY_CUSTOMER`,
  `rebuttal_strategy = CUSTOMER_INITIATED`, `recommendation = STRONG_COUNTER` (or
  `COUNTER_WITH_CAVEATS` if the surcharge looks disproportionate / was never itemised to
  the customer, or the service time is inconsistent in our records).
- **Winning stack:** (1) customer accepted the Booking Terms at checkout
  (`cancellation_policy_disclosure`); (2) customer personally made the booking and the
  late change(s) — their own messages, defeating "unrecognized"; (3) the change fell
  within 7 days → Booking Terms entitle us to retain 100% of the Booking Price as a
  Cancellation Fee, and we may also retain it where the customer fails to attend
  delivery at the Booking Time; (4) the chef's incurred costs (ingredient receipts,
  timestamped prep photos, Uber screenshots) = proof the fee is justified, framed as
  COST INCURRED, never "service delivered"; (5) no complaint by the 12 PM-next-day
  deadline → deemed acceptable per the complaints policy the customer was sent
  pre-event.
- **Framing:** the retained amount is the non-refundable **Booking Price** under
  accepted terms after the customer's own within-7-day changes and non-completion — do
  NOT centre the argument on the size of the unpaid add-on fee (that is not the disputed
  money).
- **Deadline nuance:** normally the complaint-deadline argument is barred in a
  cancellation case, but here it IS valid because the customer alleged non-delivery and
  raised it late (past 12 PM next day) — so include it.

### Branch B — MERCHANT-CAUSED → ACCEPT (narrow)
The **chef** broke the agreed terms: unilaterally moved the date/time the customer
didn't agree to, OR the "fee" has no genuine travel/logistics basis (punitive /
unrelated to a customer change). The merchant withheld an already-paid service without a
policy basis → the customer is owed a refund. Route:
`chef_attendance_assessment = MERCHANT_DECLINED_TO_PERFORM`,
`rebuttal_strategy = ACCEPT_MERCHANT_NONPERFORMANCE`, `recommendation = ACCEPT`.
Example: the chef says two days out "I can't do the agreed date, I have to move it" and
the customer refuses — chef breach → refund.

## Both sibling disputes
A split-payment booking produces two disputes (deposit + remainder). Handle them with
the **same** decision — do not counter one and accept the other.

## Never submit
The internal chef↔yhangry coaching thread (Chef-Agent / support advising the chef to
withhold service, "don't mention the 20%", how to claim payout protection) must NEVER go
into an evidence pack, in either branch.

## Card-network reality (correction to the first draft)
Accepted T&Cs **are** weighed by card networks — a documented, checkout-accepted
cancellation/change policy plus proof the customer caused the non-completion is exactly
how "services not received" disputes are won. The first version of this brief wrongly
said policy "does not bind the bank" and routed everything to ACCEPT; that was corrected.
