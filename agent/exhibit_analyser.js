// Gemini Vision-driven analysis of uploaded evidence images.
//
// When ops uploads screenshots via the "Upload Evidence" Slack modal without
// typing manual descriptions, this module:
//   1. Bundles all images + the agent's existing dispute analysis into a
//      single multimodal Gemini call.
//   2. Gets back a per-image { document_label, proves, relevance } record
//      framed in merchant-counter terms.
//   3. Returns the records in upload order, sorted by relevance, so the
//      PDF builder can label and order exhibits without ops typing a thing.
//
// Failure modes are non-fatal — caller falls back to filename-based
// descriptions when this returns null.

import { GoogleGenAI } from '@google/genai';

const googleAuthOptions = process.env.BIGQUERY_CREDENTIALS_JSON
  ? { credentials: JSON.parse(process.env.BIGQUERY_CREDENTIALS_JSON) }
  : { keyFilename: process.env.BIGQUERY_KEYFILE_PATH || './credentials/bigquery.json' };

// Lazy-init the Vertex AI client. Module-level `new GoogleGenAI(...)` would
// capture env vars before dotenv has loaded them in local test runs (see
// memory: ES module hoisting + lazy init pattern).
let _ai;
function getAi() {
  if (!_ai) {
    _ai = new GoogleGenAI({
      vertexai: true,
      project: process.env.BIGQUERY_PROJECT_ID || 'yhangry',
      location: process.env.VERTEX_LOCATION || 'us-central1',
      googleAuthOptions,
    });
  }
  return _ai;
}

function inferMimeType(filename) {
  const lower = (filename || '').toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  return 'image/png'; // best guess
}

const RELEVANCE_RANK = { HIGH: 0, MEDIUM: 1, LOW: 2, NONE: 3 };

/**
 * Analyse uploaded evidence images via Gemini Vision.
 *
 * @param {object} args
 * @param {Array<{filename: string, buffer: Buffer}>} args.images
 * @param {object} args.dispute   - Stripe dispute (id, amount, reason, network_reason_code)
 * @param {object} args.analysis - The agent's prior analysis (for rebuttal context)
 * @param {object} args.booking  - The BigQuery booking row (for customer context)
 *
 * @returns {Promise<Array<{filename, document_label, proves, relevance}>|null>}
 *   Per-image records IN UPLOAD ORDER (caller may sort by relevance).
 *   Returns null on any failure so the caller can fall back to filename-based
 *   descriptions.
 */
export async function analyseExhibits({ images, dispute, analysis, booking }) {
  if (!images?.length) return [];

  const customerName = `${booking?.first_name || ''} ${booking?.last_name || ''}`.trim();
  const eventDateStr = booking?.event_date?.value || (booking?.event_date ? String(booking.event_date) : 'unknown');
  const reasoning = (analysis?.reasoning || '').slice(0, 800);
  const rebuttalPoints = (analysis?.suggested_rebuttal_points || []).join('; ').slice(0, 800);
  const admissionQuote = analysis?.customer_admission_detected
    ? (analysis?.customer_admission_evidence || '').slice(0, 400)
    : '';

  const promptText = `You are analysing image exhibits for a Stripe payment dispute counter-submission.

CRITICAL OUTPUT RULE — NO INTERNAL JARGON:
The document_label and proves text you produce will be printed in the PDF
submitted to the cardholder's bank reviewer. NEVER include any internal ops
vocabulary in those strings, including but not limited to:
  - Rebuttal strategy enum names (CUSTOMER_INITIATED, DEADLINE,
    SERVICE_RENDERED, CLAIM_BY_CLAIM, PRE_EVENT_CONTACT,
    ACCEPT_STOLEN_CARD, CUSTOMER_ADMISSION)
  - Field/flag names (customer_admission_detected, rebuttal_strategy,
    evidence_strength, customer_claims, claim_analysis, etc.)
  - Recommendation enum values (STRONG_COUNTER, COUNTER_WITH_CAVEATS,
    ACCEPT, ESCALATE)
  - Agent process language ("agent's reasoning", "agent recommendation",
    "Image N" cross-refs, "as seen in Image 8", etc.)

Write in plain English merchant-counter framing. The reviewer should read
the proves line and understand what the document shows + why it helps the
merchant, without any indication that an internal tool produced it.

DISPUTE CONTEXT (for your reasoning only — do NOT quote in output):
- Dispute ID: ${dispute.id}
- Amount: $${((dispute.amount || 0) / 100).toFixed(2)}
- Stripe reason: ${dispute.reason || 'N/A'}
- Network reason code: ${dispute.network_reason_code || 'N/A'}
- Customer: ${customerName || 'unknown'}
- Booking #: ${booking?.order_id || 'unknown'}
- Event date: ${eventDateStr} — exhibit dates should fall on or very near this (the event day, or the days just before for ingredients / prep / travel). A date in a different month or year is almost certainly a misread.
- Internal recommendation: ${analysis?.recommendation || 'N/A'}
- Internal rebuttal strategy: ${analysis?.rebuttal_strategy || 'N/A'}
- Internal reasoning (truncated): ${reasoning}
- Suggested rebuttal points: ${rebuttalPoints}
${admissionQuote ? `- Cardholder admission text on record: "${admissionQuote}"` : ''}

I will provide ${images.length} image${images.length === 1 ? '' : 's'}. For EACH image, in upload order (index 0 first), identify what it shows and produce:

  document_label  — a short noun phrase identifying WHAT the document is (type +
                    sender where clear). Be CAREFUL with dates, addresses and
                    reference numbers: include a date ONLY if it is clearly legible
                    AND consistent with the event date above. If a date you read would
                    land in a different month/year than the event, you have almost
                    certainly misread it — re-read; if still unsure, describe the
                    document WITHOUT asserting a date (the image itself shows the date
                    to the reviewer). NEVER guess a date, address or reference number.
                    Examples:
                      "American Express dispute confirmation letter dated 1 May 2026"
                      "Supermarket receipt for groceries purchased for the booking"
                      "Google Maps drive-time from the chef's kitchen to the venue"

  proves          — 1-2 sentences explaining what this image proves about the
                    MERCHANT's counter to the dispute. Frame in terms relevant
                    to the rebuttal_strategy above. Do NOT describe the image
                    generically; speak in merchant-counter framing.

  relevance       — be SPARING with HIGH. Most cases only need 2-4 HIGH
                    exhibits — the actual smoking guns for the rebuttal
                    strategy. Score one of:

    HIGH    — DIRECTLY evidences the LOAD-BEARING argument of the
              rebuttal_strategy. Examples by strategy:

              CUSTOMER_ADMISSION (or admission detected):
                ✓ HIGH: cardholder's own admission email saying they
                  cancelled/withdrew the dispute
                ✓ HIGH: issuer's letter confirming dispute closure / re-
                  billing (e.g. American Express "you are no longer
                  disputing this charge")
                ✓ HIGH: issuer's dashboard screenshot showing dispute
                  status = Closed/Resolved
                ✓ HIGH: cardholder-sent emails to the merchant where the
                  cardholder is furnishing proof of withdrawal —
                  forwarding the issuer's confirmation letter, attaching
                  a dashboard screenshot, providing a clearer screenshot
                  after merchant request. These reinforce the admission
                  with the cardholder's own act of actively proving
                  withdrawal; they are equally load-bearing as the bare
                  "I have cancelled" sentence and belong in the pack.
                ✗ NOT HIGH: refund-attempt-failed logs, merchant emails
                  back to customer, follow-up "any updates?" emails,
                  initial complaint emails, goodwill offers — these are
                  context, not load-bearing for admission

              DEADLINE:
                ✓ HIGH: cancellation/refund policy disclosure (T&Cs page),
                  first-contact timing log relative to deadline,
                  click-to-accept screenshot
                ✗ NOT HIGH: chef survey, platform chat history

              SERVICE_RENDERED:
                ✓ HIGH: chef post-event survey, GPS check-in, day-of
                  customer acknowledgement
                ✗ NOT HIGH: menu negotiation messages, booking confirmation

              CUSTOMER_INITIATED:
                ✓ HIGH: customer-sent platform messages initiating the
                  booking, customer signing/checkout proof
                ✗ NOT HIGH: chef-sent messages, generic order details

    MEDIUM  — supportive context that strengthens the case but doesn't
              ALONE win the argument. Most exhibits land here when not
              load-bearing. Examples: booking confirmation, payment
              receipt, customer-merchant correspondence around the
              dispute, merchant's resolution-attempt emails, refund
              attempt logs, follow-up emails.

    LOW     — tangential — weak connection to the dispute or the
              rebuttal strategy. Don't pad the submission with LOW.

    NONE    — irrelevant or unidentifiable (e.g. wrong customer, off-
              topic screenshot, blurry image we can't read).

Calibration check: if you're scoring 5+ exhibits HIGH on a single case,
you're probably being too generous. Re-read the rebuttal_strategy and
ask "would this exhibit, by itself, persuade the bank reviewer?" If
no, it's MEDIUM at best.

Output STRICT JSON ARRAY only — one entry per image, in upload order. No
preamble outside the JSON. Schema:

[
  {
    "index": 0,
    "document_label": "string",
    "proves": "string",
    "relevance": "HIGH | MEDIUM | LOW | NONE"
  }
]`;

  // Multimodal parts: prompt text + each image as inlineData
  const parts = [{ text: promptText }];
  for (const img of images) {
    parts.push({
      inlineData: {
        mimeType: inferMimeType(img.filename),
        data: img.buffer.toString('base64'),
      },
    });
  }

  console.log(`[exhibit_analyser] Sending ${images.length} image(s) to Gemini Vision for ${dispute.id}`);

  // Use the stronger Pro model for exhibit vision — Flash misreads dates/text off
  // images (e.g. a grocery receipt read as "May 30 2020" instead of 26 May 2026, a
  // drive-time screenshot read as "June 2"). Fall back to Flash if Pro errors (e.g.
  // not provisioned in the region) so we degrade rather than break.
  // maxOutputTokens 32768 (bumped from 4096 on 2026-05-20 — the Khushbu 10-image
  // case truncated mid-entry at 4k; each rich entry is ~1000-1500 tokens).
  const config = { maxOutputTokens: 32768, temperature: 0.2, responseMimeType: 'application/json' };
  let result = null;
  for (const model of ['gemini-2.5-pro', 'gemini-2.5-flash']) {
    try {
      result = await getAi().models.generateContent({ model, contents: [{ role: 'user', parts }], config });
      console.log(`[exhibit_analyser] Vision via ${model}`);
      break;
    } catch (err) {
      console.warn(`[exhibit_analyser] ${model} failed: ${err?.message || err}`);
    }
  }
  if (!result) {
    console.error('[exhibit_analyser] All vision models failed');
    return null;
  }

  const text = result?.text || '';
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    console.error('[exhibit_analyser] Failed to parse Gemini output as JSON:', err.message);
    console.error('[exhibit_analyser] Raw output (first 500 chars):', text.slice(0, 500));
    return null;
  }
  if (!Array.isArray(parsed)) {
    console.error('[exhibit_analyser] Gemini output is not an array — got:', typeof parsed);
    return null;
  }

  // Index by `index` field in case Gemini shuffles ordering
  const byIndex = {};
  for (const entry of parsed) {
    if (typeof entry?.index === 'number') byIndex[entry.index] = entry;
  }

  // Build canonical per-image records in upload order. Missing fields fall
  // back to safe defaults so we never crash the PDF builder downstream.
  const records = images.map((img, i) => {
    const entry = byIndex[i] || {};
    const relevance = ['HIGH', 'MEDIUM', 'LOW', 'NONE'].includes(entry.relevance)
      ? entry.relevance
      : 'MEDIUM';
    return {
      index: i,
      filename: img.filename,
      document_label: (entry.document_label || img.filename || `Exhibit ${i + 1}`).trim(),
      proves: (entry.proves || '(no description generated)').trim(),
      relevance,
    };
  });

  console.log(
    `[exhibit_analyser] Analysed ${records.length} image(s): ` +
      records.map((r) => `${r.filename}=${r.relevance}`).join(', ')
  );

  return records;
}

/**
 * Format a Vision record into the description string expected by the PDF
 * generator's `splitExhibitDescription` helper. Uses " — " as the separator
 * since that's one of the three accepted (":", " — ", " -- ").
 */
export function formatExhibitDescription(record) {
  return `${record.document_label} — ${record.proves}`;
}

/**
 * Sort exhibit records by relevance (HIGH first), then preserve upload
 * order within a relevance tier.
 */
export function sortByRelevance(records) {
  return [...records].sort((a, b) => {
    const ra = RELEVANCE_RANK[a.relevance] ?? 99;
    const rb = RELEVANCE_RANK[b.relevance] ?? 99;
    if (ra !== rb) return ra - rb;
    return (a.index ?? 0) - (b.index ?? 0);
  });
}
