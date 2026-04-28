import { GoogleGenAI } from '@google/genai';
import * as bigquery from '../integrations/bigquery.js';
import * as aircall from '../integrations/aircall.js';
import * as bird from '../integrations/bird.js';
import * as conduit from '../integrations/conduit.js';
import * as slack from '../integrations/slack.js';
import { getComplaintDeadline } from '../utils/timezone.js';
import { SYSTEM_PROMPT, buildUserMessage } from './prompt.js';

function normalisePhoneForLookup(phone) {
  if (!phone) return null;
  let cleaned = phone.replace(/[\s\-()]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  if (cleaned.startsWith('00')) return '+' + cleaned.slice(2);
  if (cleaned.startsWith('0')) return '+44' + cleaned.slice(1);
  if (cleaned.length === 10 && cleaned.startsWith('7')) return '+44' + cleaned;
  if (cleaned.length === 10 && cleaned.startsWith('1')) return '+1' + cleaned;
  if (cleaned.length === 11 && cleaned.startsWith('44')) return '+' + cleaned;
  return '+44' + cleaned; // default UK
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
      maxOutputTokens: 8192,
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

export async function investigateDispute(dispute) {
  const disputeId = dispute.id;
  const amount = dispute.amount;
  const paymentId = dispute.payment_intent || dispute.charge;

  console.log(`[agent] Investigating dispute ${disputeId} for payment ${paymentId}`);

  // Step 1: Look up booking
  const booking = await bigquery.getBookingByPaymentId(paymentId);
  if (!booking) {
    await slack.postError(
      `DISPUTE — booking not found for payment_id: ${paymentId}`,
      { dispute_id: disputeId, amount: `$${(amount / 100).toFixed(2)}` }
    );
    return;
  }

  console.log(`[agent] Found booking ${booking.order_id} for ${booking.first_name} ${booking.last_name}`);

  // Step 2: Normalise event_date (BigQuery returns BigQueryDate object)
  const eventDateStr = booking.event_date?.value || String(booking.event_date);

  // Step 2b: Calculate deadline
  const { deadline_iso: deadlineIso, timezone } = getComplaintDeadline(
    booking.address_postcode,
    eventDateStr
  );

  // Step 3: Search window from event date
  const eventDateUnix = Math.floor(new Date(eventDateStr).getTime() / 1000);
  const eventDateIso = new Date(eventDateStr).toISOString();

  // Step 4: Normalise phone for external lookups
  const customerPhone = normalisePhoneForLookup(booking.customer_phone);
  console.log(`[agent] Customer phone normalised: ${booking.customer_phone} → ${customerPhone}`);

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

  // Step 6: Run Gemini analysis (normalise event_date for prompt)
  booking.event_date = eventDateStr;
  const analysis = await runAgent({
    dispute,
    booking,
    deadlineIso,
    timezone,
    earliestContact,
    allContacts,
    platformMessages: messages,
  });

  console.log(`[agent] Gemini recommendation: ${analysis.recommendation}`);

  // Step 7: Post to Slack
  await slack.postDisputeReview(analysis, dispute, booking, allContacts, messages);
  console.log(`[agent] Posted to Slack`);
}
