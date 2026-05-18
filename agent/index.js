import { GoogleGenAI } from '@google/genai';
import { DateTime } from 'luxon';
import * as bigquery from '../integrations/bigquery.js';
import * as aircall from '../integrations/aircall.js';
import * as bird from '../integrations/bird.js';
import * as conduit from '../integrations/conduit.js';
import * as slack from '../integrations/slack.js';
import { fetchCustomerCorrespondence } from '../integrations/gmail.js';
import { getComplaintDeadline } from '../utils/timezone.js';
import { SYSTEM_PROMPT, buildUserMessage } from './prompt.js';
import { lookupMatrixEntry } from './evidence_matrix.js';
import { computeFraudSignature } from './fraud_signature.js';

function normalisePhoneForLookup(phone, postcode) {
  if (!phone) return null;
  let cleaned = phone.replace(/[\s\-()]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  if (cleaned.startsWith('00')) return '+' + cleaned.slice(2);

  // Detect country from address postcode (best signal we have on a yhangry booking).
  const pc = String(postcode || '').trim();
  const isUS = /^\d{5}(-\d{4})?$/.test(pc);
  const isUK = /^[A-Z]{1,2}[0-9]/i.test(pc);

  // Country-specific signal-rich rules first (these don't need postcode hints):
  if (cleaned.startsWith('0')) return '+44' + cleaned.slice(1);                  // UK national format (07...)
  if (cleaned.length === 10 && cleaned.startsWith('7')) return '+44' + cleaned;  // UK mobile dropped leading 0
  if (cleaned.length === 11 && cleaned.startsWith('44')) return '+' + cleaned;   // UK with country code, no +
  if (cleaned.length === 11 && cleaned.startsWith('1')) return '+' + cleaned;    // US/CA with country code, no +

  // 10-digit numbers without obvious country signal — use postcode to disambiguate:
  if (cleaned.length === 10 && isUS) return '+1' + cleaned;
  if (cleaned.length === 10 && isUK) return '+44' + cleaned;

  // Last-resort defaults based on postcode, then UK as ultimate fallback:
  if (isUS) return '+1' + cleaned;
  if (isUK) return '+44' + cleaned;
  return '+44' + cleaned;
}

const googleAuthOptions = process.env.BIGQUERY_CREDENTIALS_JSON
  ? { credentials: JSON.parse(process.env.BIGQUERY_CREDENTIALS_JSON) }
  : { keyFilename: process.env.BIGQUERY_KEYFILE_PATH || './credentials/bigquery.json' };

const ai = new GoogleGenAI({
  vertexai: true,
  project: process.env.BIGQUERY_PROJECT_ID || 'yhangry',
  location: process.env.VERTEX_LOCATION || 'us-central1',
  googleAuthOptions,
});

async function runAgent(data) {
  const userMessage = buildUserMessage(data);

  const result = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: userMessage,
    config: {
      systemInstruction: SYSTEM_PROMPT,
      // Bumped to 16384 to accommodate customer_claims + unaddressed_claims
      // when a long VROL narrative is parsed (multiple claims with rationales).
      maxOutputTokens: 16384,
      temperature: 0.2,
      responseMimeType: 'application/json',
    },
  });

  const text = result.text || '';

  try {
    return JSON.parse(text);
  } catch (err) {
    console.error('[agent] Failed to parse Gemini response as JSON:', err.message);
    console.error('[agent] Raw response:', text);
    throw new Error('Gemini response was not valid JSON');
  }
}

/**
 * Pure analysis pipeline — pulls booking + contacts + messages, runs Gemini,
 * returns the structured result. No Slack side-effects. Used by both the
 * production investigate path and the local test harness so they execute
 * identical code.
 *
 * @param {object} dispute - Stripe dispute object (id, amount, reason, payment_intent, ...)
 * @param {object} [options]
 * @param {string} [options.narrative] - Customer narrative text (typically pasted from
 *   the VROL questionnaire by ops via the Slack 'Add Customer Narrative' button).
 *   When present, the agent parses claims and maps evidence per the prompt's
 *   "Customer Claim Parsing" rules. When absent, it produces a provisional
 *   recommendation based on deadline + attendance + evidence.
 *
 * Returns { booking, deadlineIso, timezone, allContacts, messages, analysis,
 *   paymentId } — booking will be null if the lookup failed (caller decides
 *   how to surface that).
 */
export async function analyseDispute(dispute, { narrative = null } = {}) {
  const disputeId = dispute.id;
  const paymentId = dispute.payment_intent || dispute.charge;

  console.log(`[agent] Analysing dispute ${disputeId} for payment ${paymentId}`);

  // Step 1: Look up booking
  const booking = await bigquery.getBookingByPaymentId(paymentId);
  if (!booking) {
    return { booking: null, paymentId };
  }

  console.log(`[agent] Found booking ${booking.order_id} for ${booking.first_name} ${booking.last_name}`);

  // Step 2: Normalise event_date (BigQuery returns BigQueryDate object)
  const eventDateStr = booking.event_date?.value || String(booking.event_date);

  // Step 2b: Calculate deadline (12pm local time, day after meal_date)
  const { deadline_iso: deadlineIso, timezone } = getComplaintDeadline(
    booking.address_postcode,
    eventDateStr
  );

  // Step 3: Contact-search window. The yhangry complaint window starts AFTER
  // the event ends (per yhangry T&Cs). A typical dinner booking runs:
  //   - chef arrives ~2 hours before service start (~6 PM for an 8 PM dinner)
  //   - service runs ~3 hours
  //   - cleanup + chef departure pushes total event end to ~midnight local
  // So contacts from before the event concluded are essentially always
  // prep/booking/in-flight questions, not complaints — customers raise
  // event-time issues IN PERSON to the on-site chef, not via yhangry support.
  // We use end-of-event-day local (= start of the day after the meal date in
  // the customer's timezone, i.e. midnight) as the floor. This conservatively
  // captures the genuine complaint window (post-event through 12 PM next-day
  // deadline + after) and excludes the noisy pre-event same-day contacts that
  // would otherwise be mis-tagged as "first complaint contact".
  const searchWindowStart = DateTime.fromISO(eventDateStr, { zone: timezone })
    .plus({ days: 1 })
    .startOf('day');
  const eventDateUnix = Math.floor(searchWindowStart.toMillis() / 1000);
  const eventDateIso = searchWindowStart.toISO();
  console.log(`[agent] Contact search window: from ${eventDateIso} (${timezone}) — i.e. post-event-end`);

  // Step 4: Normalise phone for external lookups (postcode disambiguates country)
  const customerPhone = normalisePhoneForLookup(booking.customer_phone, booking.address_postcode);
  console.log(`[agent] Customer phone normalised: ${booking.customer_phone} (postcode ${booking.address_postcode || 'unknown'}) → ${customerPhone}`);

  // Step 4b: Parallel first-contact search
  const [aircallResults, birdResults, conduitResults] = await Promise.allSettled([
    aircall.getInboundCalls(customerPhone, eventDateUnix),
    bird.getInboundMessages(customerPhone, eventDateIso),
    conduit.getAllContactActivity(booking.customer_email, eventDateIso),
  ]);

  const allContacts = [
    ...(aircallResults.status === 'fulfilled' ? aircallResults.value : []),
    ...(birdResults.status === 'fulfilled' ? birdResults.value : []),
    ...(conduitResults.status === 'fulfilled' ? conduitResults.value : []),
  ].sort((a, b) => new Date(a.timestamp_iso) - new Date(b.timestamp_iso));

  const earliestContact = allContacts[0] || null;

  console.log(`[agent] Found ${allContacts.length} contact attempts across all channels`);

  // Step 5: Pull platform messages
  const messages = await bigquery.getPlatformMessages(booking.order_id);
  console.log(`[agent] Found ${messages.length} platform messages`);

  // Step 5a: Pull recent Gmail correspondence with the customer
  // (Tyler retro #11). Gated on GMAIL_ENABLED — when off, returns []. When
  // on, surfaces customer admissions ("I'll withdraw the dispute", "filed
  // in error", etc.) which are the strongest possible counter-evidence.
  // Errors are non-fatal: a Gmail outage shouldn't block dispute analysis.
  let gmailMessages = [];
  try {
    gmailMessages = await fetchCustomerCorrespondence(booking.customer_email, {
      daysBack: 90,
      maxMessages: 10,
    });
  } catch (err) {
    console.warn('[agent] Gmail fetch failed (non-fatal):', err.message);
  }

  // Step 5b: Look up the evidence requirements playbook for this dispute's
  // (network, reason_code) pair. The matrix tells us which evidence types
  // win at the bank for this code so the agent can do a "what we have vs
  // what we'd need" check. Returns null if we don't have a playbook for
  // this code yet — Gemini handles that case gracefully (see prompt.js).
  const matrixEntry = lookupMatrixEntry({
    network: undefined, // inferred from reason_code prefix
    reason_code: dispute.network_reason_code,
  });
  if (matrixEntry) {
    console.log(
      `[agent] Evidence playbook: ${matrixEntry.network} ${matrixEntry.reason_code} (${matrixEntry.required_evidence.length} required, ${matrixEntry.strengthening_evidence.length} strengthening)`
    );
  } else if (dispute.network_reason_code) {
    console.log(
      `[agent] No evidence playbook for ${dispute.network_reason_code} — Gemini will proceed without requirements check`
    );
  }

  // Step 5c: Pre-event detection (Tyler retro #7). If the dispute was filed
  // BEFORE the event date, standard rebuttal logic doesn't apply — the
  // complaint deadline argument can't bind (window still in the future) and
  // service-rendered arguments are impossible (no service yet). The right
  // strategy is CUSTOMER_CONTACT_FIRST: contact the customer to clarify
  // intent, offer the booking change they likely wanted, request dispute
  // withdrawal. Katie Robertson case (2026-05-02 → 2026-05-13) is the
  // canonical example. Falls back to "now" when dispute.created is missing
  // (e.g. local fixtures don't include it).
  const disputeCreatedMs = dispute.created ? dispute.created * 1000 : Date.now();
  const eventStartMs = DateTime.fromISO(eventDateStr, { zone: timezone })
    .startOf('day')
    .toMillis();
  const isPreEvent = eventStartMs > disputeCreatedMs;
  const daysUntilEvent = Math.ceil((eventStartMs - disputeCreatedMs) / 86_400_000);
  const disputeCreatedIso = new Date(disputeCreatedMs).toISOString();
  console.log(
    `[agent] Pre-event check: dispute_created=${disputeCreatedIso} event=${eventDateStr} → isPreEvent=${isPreEvent}, daysUntilEvent=${daysUntilEvent}`
  );

  // Step 5d: Compute stolen-card fraud signature. Deterministic over Stripe
  // charge data — fraud_code prerequisite + foreign_card + no_address +
  // elevated_risk. STRONG_MATCH (all 4 fire) forces an ACCEPT override
  // below, regardless of LLM output. PARTIAL_MATCH gets passed to Gemini
  // as judgement input. See agent/fraud_signature.js.
  let fraudSignature = null;
  try {
    fraudSignature = await computeFraudSignature(dispute);
    console.log(
      `[agent] Fraud signature: verdict=${fraudSignature.verdict} score=${fraudSignature.score}/3 signals=${JSON.stringify(fraudSignature.signals)}`
    );
  } catch (err) {
    console.error('[agent] Fraud signature computation failed (non-fatal):', err.message);
  }

  // Step 6: Normalise event_date on booking for downstream display, then run Gemini
  booking.event_date = eventDateStr;
  if (narrative) {
    console.log(`[agent] Re-analysing with customer narrative (${narrative.length} chars)`);
  }
  const analysis = await runAgent({
    dispute,
    booking,
    deadlineIso,
    timezone,
    earliestContact,
    allContacts,
    platformMessages: messages,
    narrative,
    matrixEntry,
    disputeCreatedIso,
    isPreEvent,
    daysUntilEvent,
    gmailMessages,
    fraudSignature,
  });

  console.log(`[agent] Gemini recommendation: ${analysis.recommendation} (narrative_provided: ${analysis.narrative_provided})`);

  // Deterministic safety net: when the fraud signature is STRONG_MATCH the
  // case is unwinnable regardless of platform-engagement evidence (the
  // legitimate cardholder didn't authorise the charge — the engagement was
  // the fraudster). Force ACCEPT even if the LLM ignored the rule. We
  // preserve the LLM's reasoning prefixed with an override notice so ops
  // can see what was overridden.
  if (fraudSignature?.verdict === 'STRONG_MATCH' && analysis.recommendation !== 'ACCEPT') {
    console.warn(
      `[agent] Overriding LLM recommendation ${analysis.recommendation} → ACCEPT (fraud signature STRONG_MATCH)`
    );
    analysis._overrode_recommendation = analysis.recommendation;
    analysis.recommendation = 'ACCEPT';
    analysis.rebuttal_strategy = 'ACCEPT_STOLEN_CARD';
    analysis.evidence_strength = 'N/A';
    analysis.evidence_to_include = [];
    analysis.suggested_rebuttal_points = [];
    analysis.reasoning =
      `[Deterministic override applied — stolen-card signature STRONG_MATCH] ${analysis.reasoning || ''}`.trim();
    analysis.flags = [
      ...(analysis.flags || []),
      `Stolen-card signature STRONG_MATCH — recommendation overridden from ${analysis._overrode_recommendation} to ACCEPT. Issuer: ${fraudSignature.issuerCountry || 'unknown'} on a ${fraudSignature.expectedCountry || 'unknown'} Stripe account, no billing address, Stripe Radar ${fraudSignature.riskLevel || 'unknown'} risk, fraud reason code.`,
    ];
  }

  // Stash the signature on the analysis so downstream renderers (decision.js)
  // can show signal details on ACCEPT posts without re-fetching the charge.
  if (fraudSignature) {
    analysis._fraud_signature = fraudSignature;
  }

  // Step 7: Product gap tracking — record any tags Gemini emitted, then check
  // 30-day frequency thresholds and post to #product-gaps for newly-crossed
  // tags. All BigQuery operations are gated on PRODUCT_GAPS_ENABLED so this
  // is a no-op until Jordan grants Data Editor and the dataset/tables exist.
  // Wrapped in try/catch so write failures (e.g. permission denied) never
  // block the main analysis.
  try {
    await trackProductGaps({ analysis, dispute, booking });
  } catch (err) {
    console.error('[agent] Product gap tracking failed (non-fatal):', err.message);
  }

  return { booking, deadlineIso, timezone, allContacts, messages, analysis };
}

const PRODUCT_GAP_THRESHOLD = 3;

async function trackProductGaps({ analysis, dispute, booking }) {
  const tags = analysis?.product_gaps_identified || [];
  if (tags.length === 0) return;

  await bigquery.recordProductGaps({
    disputeId: dispute.id,
    bookingId: booking.order_id,
    tags,
    networkReasonCode: dispute.network_reason_code,
    eventDate: booking.event_date,
  });

  for (const tag of tags) {
    const count = await bigquery.getRecentGapCount(tag);
    if (count < PRODUCT_GAP_THRESHOLD) continue;

    const lastAlerted = await bigquery.getRecentAlert(tag);
    if (lastAlerted) continue; // already alerted within suppression window

    const recentEvents = await bigquery.getRecentEventsForTag(tag);
    await slack.postProductGapAlert({ tag, occurrenceCount: count, recentEvents });
    await bigquery.recordAlert(tag, count);
  }
}

/**
 * Production entry point: analyse a dispute and post the result to Slack.
 * Called by the Stripe webhook handler and the /test/dispute endpoint.
 */
export async function investigateDispute(dispute) {
  const disputeId = dispute.id;
  const amount = dispute.amount;

  const result = await analyseDispute(dispute);

  if (!result.booking) {
    await slack.postError(
      `DISPUTE — booking not found for payment_id: ${result.paymentId}`,
      { dispute_id: disputeId, amount: `$${(amount / 100).toFixed(2)}` }
    );
    return;
  }

  await slack.postDisputeReview(
    result.analysis,
    dispute,
    result.booking,
    result.allContacts,
    result.messages
  );
  console.log(`[agent] Posted to Slack`);
}
