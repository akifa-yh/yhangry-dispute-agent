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
  const reasoning = (analysis?.reasoning || '').slice(0, 800);
  const rebuttalPoints = (analysis?.suggested_rebuttal_points || []).join('; ').slice(0, 800);
  const admissionQuote = analysis?.customer_admission_detected
    ? (analysis?.customer_admission_evidence || '').slice(0, 400)
    : '';

  const promptText = `You are analysing image exhibits for a Stripe payment dispute counter-submission.

DISPUTE CONTEXT:
- Dispute ID: ${dispute.id}
- Amount: $${((dispute.amount || 0) / 100).toFixed(2)}
- Stripe reason: ${dispute.reason || 'N/A'}
- Network reason code: ${dispute.network_reason_code || 'N/A'}
- Customer: ${customerName || 'unknown'}
- Agent recommendation: ${analysis?.recommendation || 'N/A'}
- Rebuttal strategy: ${analysis?.rebuttal_strategy || 'N/A'}
- Agent reasoning (truncated): ${reasoning}
- Suggested rebuttal points: ${rebuttalPoints}
${admissionQuote ? `- Cardholder admission text on record: "${admissionQuote}"` : ''}

I will provide ${images.length} image${images.length === 1 ? '' : 's'}. For EACH image, in upload order (index 0 first), identify what it shows and produce:

  document_label  — a short noun phrase identifying the document. Be specific:
                    include any visible dates, reference numbers, sender/receiver
                    names, transaction IDs etc. that appear in the image.
                    Examples:
                      "American Express dispute confirmation letter dated 1 May 2026"
                      "Stripe events log showing $20 refund completed then failed on 29-30 Apr 2026"
                      "Customer email dated 30 Apr 2026 stating 'I have cancelled the dispute'"

  proves          — 1-2 sentences explaining what this image proves about the
                    MERCHANT's counter to the dispute. Frame in terms relevant
                    to the rebuttal_strategy above. Do NOT describe the image
                    generically; speak in merchant-counter framing.

  relevance       — one of:
    HIGH    — directly evidences a key rebuttal point (cardholder admission,
              issuer's dispute-withdrawal confirmation, Stripe refund-failed
              event log, written settlement agreement)
    MEDIUM  — supportive context (booking confirmation, payment receipt,
              generic correspondence between merchant and customer)
    LOW     — tangential — weak connection to the dispute or the rebuttal
              strategy
    NONE    — irrelevant or unidentifiable (e.g. wrong customer, off-topic
              screenshot)

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

  let result;
  try {
    result = await getAi().models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{ role: 'user', parts }],
      config: {
        maxOutputTokens: 4096,
        temperature: 0.2,
        responseMimeType: 'application/json',
      },
    });
  } catch (err) {
    console.error('[exhibit_analyser] Gemini call failed:', err?.message || err);
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
