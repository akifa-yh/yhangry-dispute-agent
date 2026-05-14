import PDFDocument from 'pdfkit';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================================================
// Click-to-Accept screenshot helpers (Tyler retro #4)
// ============================================================================
// Codes where the yhangry checkout screenshot is required evidence per the
// matrix. For 13.x and MC 4853/4860 it proves click-to-accept on T&Cs /
// cancellation policy. For 12.x (processing-error codes added in retro #9)
// it doubles as currency_disclosure_at_checkout — proving the merchant-
// currency price was shown to the customer pre-payment.
const CLICK_TO_ACCEPT_CODES = new Set([
  'visa:12.3', 'visa:12.5', 'visa:12.6.1', 'visa:12.6.2',
  'visa:13.3', 'visa:13.5', 'visa:13.6', 'visa:13.7',
  'mastercard:4853', 'mastercard:4860',
]);

function inferDisputeNetwork(dispute) {
  const n = (dispute?.network || '').toLowerCase();
  if (n) return n;
  const c = String(dispute?.network_reason_code || '').trim();
  if (/^\d{2}\.\d/.test(c)) return 'visa';
  if (/^4\d{3}$/.test(c)) return 'mastercard';
  return '';
}

function shouldEmbedCheckoutScreenshot(dispute) {
  const code = String(dispute?.network_reason_code || '').trim();
  return CLICK_TO_ACCEPT_CODES.has(`${inferDisputeNetwork(dispute)}:${code}`);
}

function drawCheckoutScreenshotPage(doc) {
  const imgPath = path.join(__dirname, '..', 'assets', 'checkout-click-to-accept.jpeg');
  if (!fs.existsSync(imgPath)) {
    console.warn('[evidence] checkout-click-to-accept.jpeg missing — skipping screenshot page');
    return;
  }
  doc.addPage();
  exhibitHeading(doc,
    'yhangry Checkout — Click-to-Accept Disclosure',
    'Booking terms, privacy policy, and stored-payment authorisation are surfaced and acceptance is required before payment can complete.'
  );
  doc.image(imgPath, 50, doc.y, { fit: [495, 640], align: 'center' });
}

// Generic exhibit-page helper for user-uploaded images. Each exhibit becomes
// its own page with an "Exhibit <label>" header and the image embedded at
// fit-to-page. Tyler retro #8 sub-commit 2.
//
// `exhibit.source` can be:
//   - a Buffer (e.g. fetched from Slack file URL by the upload handler)
//   - an absolute file path
//   - anything else pdfkit's doc.image() accepts (readable streams)
function drawImageExhibitPage(doc, exhibit) {
  doc.addPage();
  exhibitHeading(doc,
    `Exhibit ${exhibit.label}`,
    exhibit.description || ''
  );
  try {
    doc.image(exhibit.source, 50, doc.y, { fit: [495, 640], align: 'center' });
  } catch (err) {
    console.warn(`[evidence] Failed to embed exhibit ${exhibit.label}:`, err.message);
    doc.fontSize(9).font('Helvetica-Oblique').fillColor(GREY_TEXT)
      .text(`(Failed to embed image: ${err.message})`, 50, doc.y, { width: 495 });
    doc.fillColor('#000000');
  }
}

// ============================================================================
// Stream + page helpers
// ============================================================================

function collectBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

function checkPageSpace(doc, needed = 100) {
  if (doc.y > 720 - needed) doc.addPage();
}

// ============================================================================
// Evidence normalisation + sorting (preserved from prior version)
// ============================================================================

function normaliseEvidence(item) {
  if (typeof item === 'string') {
    return { evidence: item, independence_score: null, strategic_priority: null, rationale: null };
  }
  return {
    evidence: item.evidence || '',
    independence_score: item.independence_score || null,
    strategic_priority: item.strategic_priority || null,
    rationale: item.rationale || null,
  };
}

const PRIORITY_RANK = { PRIMARY: 0, SECONDARY: 1, TERTIARY: 2 };
const INDEPENDENCE_RANK = { HIGH: 0, MEDIUM: 1, LOW: 2 };

function sortEvidenceForRender(items) {
  return [...items].sort((a, b) => {
    const ap = PRIORITY_RANK[a.strategic_priority] ?? 99;
    const bp = PRIORITY_RANK[b.strategic_priority] ?? 99;
    if (ap !== bp) return ap - bp;
    const ai = INDEPENDENCE_RANK[a.independence_score] ?? 99;
    const bi = INDEPENDENCE_RANK[b.independence_score] ?? 99;
    return ai - bi;
  });
}

const INDEPENDENCE_BADGE = {
  HIGH: { label: 'HIGH', fill: '#2E7D32', text: '#FFFFFF' },
  MEDIUM: { label: 'MEDIUM', fill: '#1565C0', text: '#FFFFFF' },
  LOW: { label: 'LOW', fill: '#F9A825', text: '#000000' },
};
const PRIORITY_BADGE = {
  PRIMARY: { label: 'PRIMARY', fill: '#1A237E', text: '#FFFFFF' },
  SECONDARY: { label: 'SECONDARY', fill: '#455A64', text: '#FFFFFF' },
  TERTIARY: { label: 'TERTIARY', fill: '#9E9E9E', text: '#FFFFFF' },
};

function drawBadge(doc, x, y, badge) {
  if (!badge) return 0;
  const padding = 4;
  doc.fontSize(7).font('Helvetica-Bold');
  const w = doc.widthOfString(badge.label) + padding * 2;
  doc.roundedRect(x, y, w, 11, 2).fill(badge.fill);
  doc.fillColor(badge.text).text(badge.label, x + padding, y + 2);
  doc.fillColor('#000000');
  return w;
}

// ============================================================================
// Date formatting helpers
// ============================================================================

function formatEventDateLong(raw) {
  if (!raw) return 'N/A';
  const s = raw?.value || String(raw);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return s;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${m[3]} ${months[parseInt(m[2], 10) - 1]} ${m[1]}`;
}

function formatTimelineDate(iso) {
  if (!iso) return '—';
  const s = iso?.value || String(iso);
  if (s.includes('T')) return s.replace('T', ' ').slice(0, 16);
  return s.slice(0, 16);
}

// ============================================================================
// Skimmer-first page 1 layout helpers (Tyler retro #8 — sub-commit 1)
// ============================================================================

const NAVY = '#1A237E';
const GREEN_DARK = '#2E7D32';
const GREEN_BG = '#E8F5E9';
const AMBER_DARK = '#E65100';
const AMBER_BG = '#FFF3E0';
const BLUE_DARK = '#1565C0';
const BLUE_BG = '#E3F2FD';
const GREY_BG = '#F5F5F5';
const GREY_BORDER = '#CCCCCC';
const GREY_TEXT = '#555555';

/**
 * Pick the strongest single point to feature in the BOTTOM-LINE callout.
 * Priority order:
 *   1. CUSTOMER_CONTACT_FIRST recommendation → pre-event banner
 *   2. LATE_COMPLAINT with measurable lateness → procedural argument
 *   3. NO_COMPLAINT_FOUND → procedural argument
 *   4. Chef survey submitted (CONFIRMED attendance) → service-rendered
 *   5. PRIMARY/HIGH evidence_to_include item → strongest evidence
 *   6. Fallback → reasoning summary
 */
function pickBottomLine(analysis, dispute, booking) {
  if (analysis.recommendation === 'CUSTOMER_CONTACT_FIRST') {
    const eventStr = formatEventDateLong(booking.event_date);
    return {
      headline: 'PRE-EVENT DISPUTE — CONTACT CUSTOMER FIRST',
      detail: `The event has not yet taken place (scheduled ${eventStr}). The customer has likely filed this dispute in error — currency confusion, wanting a booking amendment, etc. The right next step is to contact the customer directly to clarify intent, offer the booking change they may have wanted, and request they withdraw the dispute with their issuing bank. Submit a rebuttal only if they refuse and the event date passes.`,
      tone: 'pre-event',
    };
  }

  const ec = analysis.earliest_contact;
  if (analysis.deadline_status === 'LATE_COMPLAINT' && ec?.minutes_relative_to_deadline != null) {
    const mins = Math.abs(ec.minutes_relative_to_deadline);
    const human = mins >= 60 ? `${Math.floor(mins / 60)} HOURS ${mins % 60} MINS` : `${mins} MINUTES`;
    return {
      headline: `LATE COMPLAINT — ${human} PAST YHANGRY'S T&C DEADLINE`,
      detail: `Cardholder's first complaint contact was at ${ec.timestamp_iso} via ${ec.channel || 'unknown channel'} (${ec.type || 'unknown type'}), past yhangry's T&C deadline of 12:00 PM local time on the day following the event. The deadline is binding under the agreed booking terms (yhangry.com/booking-terms).`,
      tone: 'strong',
    };
  }

  if (analysis.deadline_status === 'NO_COMPLAINT_FOUND') {
    return {
      headline: 'NO COMPLAINT LODGED WITHIN T&C WINDOW',
      detail: 'No contact attempts found across Aircall, Bird, or Conduit channels within the complaint window. The cardholder bypassed the merchant\'s complaint process and filed directly with their issuing bank — a procedural failure to comply with the agreed booking terms.',
      tone: 'strong',
    };
  }

  if (analysis.chef_attendance_assessment === 'CONFIRMED' && booking.chef_submitted_payment_survey) {
    const chefName = `${booking.chef_first_name || ''} ${booking.chef_last_name || ''}`.trim() || 'The chef';
    return {
      headline: 'CHEF ATTENDANCE CONFIRMED — POST-BOOKING SURVEY SUBMITTED',
      detail: `${chefName} submitted the yhangry post-booking payment survey, a system-recorded HIGH-independence event that can only be created after the job is completed. This is direct proof of service delivery.`,
      tone: 'strong',
    };
  }

  const items = sortEvidenceForRender((analysis.evidence_to_include || []).map(normaliseEvidence));
  const primaryHigh = items.find(e => e.strategic_priority === 'PRIMARY' && e.independence_score === 'HIGH');
  if (primaryHigh) {
    return {
      headline: 'STRONGEST EVIDENCE',
      detail: primaryHigh.evidence,
      tone: 'moderate',
    };
  }

  return {
    headline: 'SEE EVIDENCE INDEX BELOW',
    detail: analysis.reasoning || 'Refer to the evidence index below.',
    tone: 'neutral',
  };
}

function drawBottomLineCallout(doc, callout) {
  const tones = {
    'strong':    { bg: GREEN_BG, border: GREEN_DARK, text: GREEN_DARK },
    'pre-event': { bg: AMBER_BG, border: AMBER_DARK, text: AMBER_DARK },
    'moderate':  { bg: BLUE_BG,  border: BLUE_DARK,  text: BLUE_DARK },
    'neutral':   { bg: GREY_BG,  border: GREY_BORDER, text: '#000000' },
  };
  const t = tones[callout.tone] || tones.neutral;

  const x = 50, w = 495, padding = 10;
  const startY = doc.y;

  // Measure heights
  doc.fontSize(11).font('Helvetica-Bold');
  const headlineH = doc.heightOfString(`★ ${callout.headline}`, { width: w - padding * 2 });
  doc.fontSize(9).font('Helvetica');
  const detailH = doc.heightOfString(callout.detail, { width: w - padding * 2 });
  const totalH = padding + headlineH + 4 + detailH + padding;

  doc.lineWidth(1.5);
  doc.roundedRect(x, startY, w, totalH, 4).fillAndStroke(t.bg, t.border);
  doc.lineWidth(1);

  doc.fillColor(t.text).fontSize(11).font('Helvetica-Bold')
    .text(`★ ${callout.headline}`, x + padding, startY + padding, { width: w - padding * 2 });

  doc.fillColor('#000000').fontSize(9).font('Helvetica')
    .text(callout.detail, x + padding, doc.y + 2, { width: w - padding * 2 });

  doc.fillColor('#000000');
  doc.y = startY + totalH + 10;
}

function drawFactsGrid(doc, dispute, booking, analysis) {
  const cells = [
    {
      label: 'TRANSACTION',
      value: `$${(dispute.amount / 100).toFixed(2)}`,
      sub: dispute.network_reason_code || dispute.reason || '—',
    },
    {
      label: 'BOOKING',
      value: `#${booking.order_id || analysis.booking_id}`,
      sub: formatEventDateLong(booking.event_date),
    },
    {
      label: 'CUSTOMER',
      value: `${booking.first_name || ''} ${booking.last_name || ''}`.trim() || '—',
      sub: `Chef ${booking.chef_first_name || ''} ${booking.chef_last_name || ''}`.trim(),
    },
    {
      label: 'STATUS',
      value: analysis.recommendation || '—',
      sub: analysis.rebuttal_strategy ? analysis.rebuttal_strategy.replace(/_/g, ' ') : '',
    },
  ];

  const x0 = 50, w = 495, rowH = 52;
  const cellW = w / cells.length;
  const startY = doc.y;

  for (let i = 0; i < cells.length; i++) {
    const cellX = x0 + i * cellW;
    doc.rect(cellX, startY, cellW, rowH).fill(GREY_BG);
    doc.lineWidth(0.5).strokeColor(GREY_BORDER);
    doc.rect(cellX, startY, cellW, rowH).stroke();

    doc.fillColor(GREY_TEXT).fontSize(7).font('Helvetica')
      .text(cells[i].label, cellX, startY + 6, { width: cellW, align: 'center' });
    doc.fillColor(NAVY).fontSize(11).font('Helvetica-Bold')
      .text(cells[i].value, cellX, startY + 19, { width: cellW, align: 'center' });
    doc.fillColor(GREY_TEXT).fontSize(7).font('Helvetica')
      .text(cells[i].sub, cellX, startY + 38, { width: cellW, align: 'center' });
  }

  doc.fillColor('#000000').strokeColor('#000000').lineWidth(1);
  doc.y = startY + rowH + 12;
}

function drawSectionHeading(doc, text) {
  checkPageSpace(doc, 40);
  doc.fontSize(11).font('Helvetica-Bold').fillColor(NAVY)
    .text(text, 50, doc.y);
  doc.fillColor('#000000');
  doc.y += 4;
}

function drawRebuttalBullets(doc, analysis) {
  drawSectionHeading(doc, 'Why this dispute should resolve in the merchant\'s favour');

  const points = analysis.suggested_rebuttal_points || [];
  if (points.length === 0) {
    doc.fontSize(9).font('Helvetica-Oblique').fillColor(GREY_TEXT)
      .text('No specific rebuttal points generated.', 50, doc.y, { width: 495 });
    doc.fillColor('#000000');
    doc.y += 14;
    return;
  }

  // Show up to 3 bullets — anything more dilutes the message
  const shown = points.slice(0, 3);
  for (const point of shown) {
    checkPageSpace(doc, 30);
    const startY = doc.y;
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#000000')
      .text('•', 50, startY, { width: 12 });
    doc.fontSize(9).font('Helvetica')
      .text(point, 62, startY, { width: 483 });
    doc.y += 4;
  }
  doc.y += 4;
}

function drawCompactTimeline(doc, analysis, dispute, booking) {
  drawSectionHeading(doc, 'Timeline');

  const rows = [];

  rows.push([
    formatEventDateLong(booking.event_date),
    `Event scheduled — Chef ${booking.chef_first_name || ''} ${booking.chef_last_name || ''}, ${booking.number_of_guests || '?'} guests`,
  ]);

  if (analysis.earliest_contact?.timestamp_iso) {
    rows.push([
      formatTimelineDate(analysis.earliest_contact.timestamp_iso),
      `First complaint contact — ${analysis.earliest_contact.channel || 'unknown'} (${analysis.earliest_contact.type || 'unknown'})`,
    ]);
  } else if (analysis.deadline_status === 'NO_COMPLAINT_FOUND') {
    rows.push(['—', 'No complaint contact found across any channel within the T&C window']);
  }

  if (analysis.deadline_iso) {
    rows.push([
      formatTimelineDate(analysis.deadline_iso),
      'yhangry T&C complaint deadline (12:00 PM local time, day after event)',
    ]);
  }

  rows.push([
    analysis.dispute_id ? `Dispute ${analysis.dispute_id}` : 'Dispute filed',
    'Cardholder filed dispute with issuing bank',
  ]);

  const x0 = 50, w = 495, colDate = 130, colEvent = w - colDate, rowH = 22;

  for (let i = 0; i < rows.length; i++) {
    checkPageSpace(doc, rowH + 4);
    const rowY = doc.y;
    doc.rect(x0, rowY, w, rowH).fill(i % 2 === 0 ? GREY_BG : '#FFFFFF');
    doc.lineWidth(0.5).strokeColor(GREY_BORDER).rect(x0, rowY, w, rowH).stroke();

    doc.fillColor('#000000').fontSize(8).font('Helvetica-Bold')
      .text(rows[i][0], x0 + 6, rowY + 6, { width: colDate - 12 });
    doc.fontSize(8).font('Helvetica')
      .text(rows[i][1], x0 + colDate, rowY + 6, { width: colEvent - 12 });

    doc.y = rowY + rowH;
  }

  doc.strokeColor('#000000').lineWidth(1);
  doc.y += 12;
}

function drawCompactEvidenceIndex(doc, analysis) {
  drawSectionHeading(doc, 'Evidence to include');

  const items = sortEvidenceForRender(
    (analysis.evidence_to_include || []).map(normaliseEvidence)
  );

  if (items.length === 0) {
    doc.fontSize(9).font('Helvetica-Oblique').fillColor(GREY_TEXT)
      .text('No specific evidence items recommended.', 50, doc.y, { width: 495 });
    doc.fillColor('#000000');
    doc.y += 14;
    return;
  }

  // Find the star — first PRIMARY+HIGH item, used in the BOTTOM-LINE callout
  const starIndex = items.findIndex(e =>
    e.strategic_priority === 'PRIMARY' && e.independence_score === 'HIGH'
  );

  const x0 = 50, w = 495;

  // Header row
  const headerY = doc.y;
  doc.rect(x0, headerY, w, 18).fill(NAVY);
  doc.fillColor('#FFFFFF').fontSize(8).font('Helvetica-Bold');
  doc.text('#', x0 + 6, headerY + 5, { width: 14 });
  doc.text('PRIORITY', x0 + 22, headerY + 5, { width: 55 });
  doc.text('SOURCE', x0 + 78, headerY + 5, { width: 50 });
  doc.text('EVIDENCE', x0 + 132, headerY + 5, { width: w - 138 });
  doc.fillColor('#000000');
  doc.y = headerY + 18;

  // Data rows — show all items in compact form (no rationale text)
  items.forEach((item, i) => {
    const isStarRow = i === starIndex;
    const rowMinH = 22;
    checkPageSpace(doc, rowMinH + 6);

    // Measure evidence text height
    doc.fontSize(8).font('Helvetica');
    const evidenceH = doc.heightOfString(item.evidence || '', { width: w - 138 - 6 });
    const rowH = Math.max(rowMinH, evidenceH + 10);

    const rowY = doc.y;
    const bgColor = isStarRow ? '#FFF8E1' : (i % 2 === 0 ? GREY_BG : '#FFFFFF');
    doc.rect(x0, rowY, w, rowH).fill(bgColor);
    doc.lineWidth(0.5).strokeColor(GREY_BORDER).rect(x0, rowY, w, rowH).stroke();

    // Number (with star if applicable)
    doc.fillColor('#000000').fontSize(8).font('Helvetica-Bold')
      .text(isStarRow ? `★${i + 1}` : `${i + 1}`, x0 + 6, rowY + 6, { width: 14 });

    // Priority badge
    if (item.strategic_priority) {
      const pb = PRIORITY_BADGE[item.strategic_priority];
      if (pb) drawBadge(doc, x0 + 22, rowY + 5, pb);
    }

    // Independence badge
    if (item.independence_score) {
      const ib = INDEPENDENCE_BADGE[item.independence_score];
      if (ib) drawBadge(doc, x0 + 78, rowY + 5, ib);
    }

    // Evidence text
    doc.fillColor('#000000').fontSize(8).font('Helvetica')
      .text(item.evidence || '', x0 + 132, rowY + 5, { width: w - 138 });

    doc.y = rowY + rowH;
  });

  doc.strokeColor('#000000').lineWidth(1);
  doc.y += 8;
}

// ============================================================================
// Exhibit page heading (used by click-to-accept and any future exhibits)
// ============================================================================

function exhibitHeading(doc, title, subtitle) {
  doc.fontSize(14).font('Helvetica-Bold').fillColor(NAVY)
    .text(title, 50, doc.y);
  if (subtitle) {
    doc.fontSize(9).font('Helvetica-Oblique').fillColor(GREY_TEXT)
      .text(subtitle, 50, doc.y + 2, { width: 495 });
    doc.fillColor('#000000');
  }
  doc.fillColor('#000000');
  doc.y += 12;
}

// ============================================================================
// Platform messages — chat bubbles (preserved from prior version)
// ============================================================================

function formatMessageTimestamp(raw) {
  const s = raw?.value || raw;
  if (!s) return '';
  const str = String(s);
  return str.includes('T') ? str.replace('T', ' ').slice(0, 16) : str.slice(0, 16);
}

function senderDisplayName(message) {
  const role = (message.sender_role || '').toLowerCase();
  if (role === 'chef') return message.chef_first_name || 'Chef';
  if (role === 'customer') return message.customer_first_name || 'Customer';
  if (role === 'admin') return 'yhangry system';
  return 'unknown';
}

function drawChatBubble(doc, message) {
  const sender = (message.sender_role || 'unknown').toUpperCase();
  const name = senderDisplayName(message);
  const body = (message.body || '').slice(0, 400);
  const time = formatMessageTimestamp(message.created_at);

  const isChef = sender === 'CHEF';
  const isAdmin = sender === 'ADMIN';
  const bubbleColor = isAdmin ? '#FFF3CD' : isChef ? '#DCF8C6' : '#FFFFFF';
  const x = isChef ? 50 : isAdmin ? 50 : 180;
  const maxWidth = isAdmin ? 495 : 330;

  checkPageSpace(doc, 60);

  doc.fontSize(7).font('Helvetica').fillColor('#999999')
    .text(`${time} — ${sender} (${name})`, x, doc.y, { width: maxWidth });

  const bubbleY = doc.y;
  const textHeight = doc.heightOfString(body, { width: maxWidth - 20, fontSize: 9 });
  const bubbleHeight = textHeight + 14;

  doc.roundedRect(x, bubbleY, maxWidth, bubbleHeight, 8)
    .fillAndStroke(bubbleColor, '#E0E0E0');

  doc.fontSize(9).font('Helvetica').fillColor('#000000')
    .text(body, x + 10, bubbleY + 7, { width: maxWidth - 20 });

  doc.y = bubbleY + bubbleHeight + 8;
}

// ============================================================================
// Contact log table (preserved from prior version)
// ============================================================================

function drawCallLogTable(doc, contacts) {
  if (!contacts || contacts.length === 0) return;

  const tableX = 50;

  doc.roundedRect(tableX, doc.y, 495, 20, 3).fillAndStroke('#333333', '#333333');
  const headerY = doc.y + 5;
  doc.fontSize(8).font('Helvetica-Bold').fillColor('#FFFFFF');
  doc.text('Timestamp', tableX + 5, headerY, { width: 160 });
  doc.text('Type', tableX + 170, headerY, { width: 80 });
  doc.text('Duration', tableX + 255, headerY, { width: 80 });
  doc.text('Answered', tableX + 340, headerY, { width: 80 });
  doc.text('Channel', tableX + 425, headerY, { width: 70 });
  doc.fillColor('#000000');
  doc.y = doc.y + 22;

  for (let i = 0; i < contacts.length; i++) {
    checkPageSpace(doc, 20);
    const c = contacts[i];
    const rowY = doc.y;
    const bgColor = i % 2 === 0 ? '#F9F9F9' : '#FFFFFF';

    doc.rect(tableX, rowY, 495, 18).fill(bgColor);
    doc.fontSize(8).font('Helvetica').fillColor('#000000');
    doc.text(c.timestamp_iso || '', tableX + 5, rowY + 4, { width: 160 });
    doc.text(c.type || '', tableX + 170, rowY + 4, { width: 80 });
    doc.text(c.duration_seconds ? `${c.duration_seconds}s` : '', tableX + 255, rowY + 4, { width: 80 });
    doc.text(c.answered != null ? (c.answered ? 'Yes' : 'No') : '', tableX + 340, rowY + 4, { width: 80 });
    doc.text(c.channel || '', tableX + 425, rowY + 4, { width: 70 });
    doc.y = rowY + 18;
  }
}

// ============================================================================
// Main entry point
// ============================================================================

/**
 * Generate the merchant response PDF.
 *
 * @param {object} args
 * @param {object} args.analysis - Gemini analysis JSON
 * @param {object} args.dispute - Stripe dispute object
 * @param {object} args.booking - BigQuery booking row
 * @param {Array<object>} args.platformMessages - chef/customer messages
 * @param {Array<object>} args.allContacts - inbound contact attempts
 * @param {Array<object>} [args.exhibits] - optional user-uploaded image
 *   exhibits, each {label?, description?, source} where source is a Buffer
 *   or file path. Labels auto-assigned A, B, C... if not provided. Tyler
 *   retro #8 sub-commit 2 — populated by the Slack "Upload Evidence" flow
 *   in sub-commit 3; safely empty/missing when called from the standard
 *   "Approve & Generate Evidence" button.
 */
export async function generateEvidence({ analysis, dispute, booking, platformMessages, allContacts, exhibits }) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const bufferPromise = collectBuffer(doc);

  // ===== PAGE 1: Skimmer-first merchant response summary =====
  // (Tyler retro #8 sub-commit 1)
  // The whole story in one scannable page: header → green BOTTOM-LINE
  // callout → 4-cell facts grid → 3-bullet rebuttal → compact timeline →
  // evidence index with ★-marked strongest item. Designed for a Stripe/bank
  // reviewer's 30-second scan; the ★ exhibit appears highlighted in gold.

  const customerName = `${booking.first_name || ''} ${booking.last_name || ''}`.trim() || 'Cardholder';

  // Title
  doc.fontSize(14).font('Helvetica-Bold').fillColor(NAVY)
    .text(`Merchant Response — ${customerName}`, 50, doc.y);
  doc.fillColor('#000000');

  // Subtitle line
  const subtitleParts = [
    `Dispute ${analysis.dispute_id || dispute.id}`,
    dispute.network_reason_code ? `Reason ${dispute.network_reason_code}` : null,
    'yhangry / Stripe Payments',
  ].filter(Boolean);
  doc.fontSize(8).font('Helvetica-Oblique').fillColor(GREY_TEXT)
    .text(subtitleParts.join('  •  '), 50, doc.y + 2);
  doc.fillColor('#000000');
  doc.y += 12;

  // BOTTOM-LINE callout (the headline)
  const callout = pickBottomLine(analysis, dispute, booking);
  drawBottomLineCallout(doc, callout);

  // 4-cell facts grid
  drawFactsGrid(doc, dispute, booking, analysis);

  // 3-bullet rebuttal section
  drawRebuttalBullets(doc, analysis);

  // Compact timeline
  drawCompactTimeline(doc, analysis, dispute, booking);

  // Evidence index (with ★ on the row featured in the BOTTOM-LINE callout)
  drawCompactEvidenceIndex(doc, analysis);

  // ===== PAGE 2+: Platform Messages (Chat Bubbles) =====
  doc.addPage();
  exhibitHeading(doc,
    `Platform Messages — yhangry Booking #${analysis.booking_id || booking.order_id}`,
    'Messages between chef and customer on the yhangry platform'
  );

  if (platformMessages && platformMessages.length > 0) {
    for (const m of platformMessages) {
      drawChatBubble(doc, m);
    }
  } else {
    doc.fontSize(9).font('Helvetica').text('No platform messages available.');
  }

  // ===== Click-to-Accept Screenshot (Visa 13.3/13.5/13.6/13.7, MC 4853/4860) =====
  if (shouldEmbedCheckoutScreenshot(dispute)) {
    drawCheckoutScreenshotPage(doc);
  }

  // ===== Contact Log (Aircall / Bird / Conduit) =====
  if (allContacts && allContacts.length > 0) {
    doc.addPage();
    exhibitHeading(doc,
      'Inbound Contact Log',
      `Customer phone: ${booking.customer_phone || 'n/a'} | All channels from event date onwards`
    );
    drawCallLogTable(doc, allContacts);
  }

  // ===== User-uploaded exhibits (Tyler retro #8 sub-commit 2) =====
  // Each exhibit becomes its own page. Labels auto-assigned A, B, C... if
  // not provided. Populated by the Slack "Upload Evidence" flow (sub-commit 3).
  const exhibitList = Array.isArray(exhibits) ? exhibits : [];
  for (let i = 0; i < exhibitList.length; i++) {
    const ex = exhibitList[i] || {};
    if (!ex.source) {
      console.warn(`[evidence] Skipping exhibit at index ${i} — no source`);
      continue;
    }
    const label = ex.label || String.fromCharCode(65 + i); // A, B, C, ...
    drawImageExhibitPage(doc, { ...ex, label });
  }

  doc.end();
  return await bufferPromise;
}
