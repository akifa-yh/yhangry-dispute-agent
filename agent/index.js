import { GoogleGenAI } from '@google/genai';
import { DateTime } from 'luxon';
import * as bigquery from '../integrations/bigquery.js';
import * as aircall from '../integrations/aircall.js';
import * as bird from '../integrations/bird.js';
import * as conduit from '../integrations/conduit.js';
import * as slack from '../integrations/slack.js';
import { getComplaintDeadline } from '../utils/timezone.js';
import { SYSTEM_PROMPT, buildUserMessage } from './prompt.js';

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

  // Step 3: Contact-search window. Start at noon local on the event date —
  // earlier same-day contacts are almost always prep/booking questions
  // rather than complaints (the event hasn't happened yet), and customers
  // verbally raise issues with the on-site chef during the event itself
  // rather than calling yhangry support pre-event. This prevents pre-event
  // noise (e.g. a 1:30 AM voicemail on the morning of the event) from being
  // mis-tagged as the "first complaint contact" in deadline analysis.
  const searchWindowStart = DateTime.fromISO(eventDateStr, { zone: timezone })
    .set({ hour: 12, minute: 0, second: 0, millisecond: 0 });
  const eventDateUnix = Math.floor(searchWindowStart.toMillis() / 1000);
  const eventDateIso = searchWindowStart.toISO();
  console.log(`[agent] Contact search window: from ${eventDateIso} (${timezone})`);

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
  });

  console.log(`[agent] Gemini recommendation: ${analysis.recommendation} (narrative_provided: ${analysis.narrative_provided})`);

  return { booking, deadlineIso, timezone, allContacts, messages, analysis };
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
