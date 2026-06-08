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

// Codes where the cancellation/refund T&Cs screenshot is material evidence.
// Tyler retro: Tyler's bank explicitly cited "click-to-accept on cancellation
// policy not demonstrated" as the reason for losing on 13.3, so 13.3 is
// included. 13.5 (misrepresentation), 13.6 (credit not processed), 13.7
// (cancelled merchandise), and the Mastercard equivalents 4853/4860 all
// turn on whether the customer was bound by the cancellation policy.
// Excluded: 12.x processing-error codes (cancellation policy irrelevant
// for amount/currency disputes); fraud codes 10.4/4837/4863 (cardholder
// is denying authorisation, not invoking cancellation rights).
const CANCELLATION_TERMS_CODES = new Set([
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

function shouldEmbedCancellationTermsScreenshot(dispute) {
  const code = String(dispute?.network_reason_code || '').trim();
  return CANCELLATION_TERMS_CODES.has(`${inferDisputeNetwork(dispute)}:${code}`);
}

function drawCheckoutScreenshotPage(doc, letter) {
  const imgPath = path.join(__dirname, '..', 'assets', 'checkout-click-to-accept.jpeg');
  if (!fs.existsSync(imgPath)) {
    console.warn('[evidence] checkout-click-to-accept.jpeg missing — skipping screenshot page');
    return;
  }
  doc.addPage();
  exhibitHeading(doc,
    letter ? `Exhibit ${letter}` : 'yhangry Checkout — Click-to-Accept Disclosure',
    'yhangry checkout screenshot — booking terms, privacy policy, and merchant-currency pricing are surfaced at checkout; acceptance required before payment.'
  );
  doc.image(imgPath, 50, doc.y, { fit: [495, 640], align: 'center' });
}

function drawCancellationTermsPage(doc, letter) {
  const imgPath = path.join(__dirname, '..', 'assets', 'cancellation-terms.jpeg');
  if (!fs.existsSync(imgPath)) {
    console.warn('[evidence] cancellation-terms.jpeg missing — skipping screenshot page');
    return;
  }
  doc.addPage();
  exhibitHeading(doc,
    letter ? `Exhibit ${letter}` : 'yhangry Booking Terms — Cancellation Policy',
    'yhangry booking terms (yhangry.com/booking-terms) — cancellation/refund clauses the customer agreed to at checkout. 100% cancellation fee within 7 days of booking time.'
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
 *
 * Priority order:
 *   1. Customer admission from Gmail (Tyler retro #11) — strongest possible
 *      evidence; bank reviewers rule for merchant nearly every time when
 *      cardholder admits the dispute was filed in error
 *   2. CUSTOMER_CONTACT_FIRST recommendation → pre-event banner
 *   3. 12.x processing-error codes → "no discrepancy" framing
 *   4. Everything else → procedural (late/no-complaint) > service-rendered >
 *      PRIMARY/HIGH evidence > reasoning summary
 */
function pickBottomLine(analysis, dispute, booking) {
  // Customer admission trumps everything. Surface the literal quote.
  if (analysis.customer_admission_detected === true && analysis.customer_admission_evidence) {
    return {
      headline: 'CARDHOLDER ADMITTED THE DISPUTE WAS FILED IN ERROR',
      detail: `Cardholder's own written statement (from Gmail correspondence with info@yhangry.com): "${String(analysis.customer_admission_evidence).trim()}"`,
      tone: 'strong',
    };
  }

  if (analysis.recommendation === 'CUSTOMER_CONTACT_FIRST') {
    const eventStr = formatEventDateLong(booking.event_date);
    return {
      headline: 'PRE-EVENT DISPUTE — CONTACT CUSTOMER FIRST',
      detail: `The event has not yet taken place (scheduled ${eventStr}). The customer has likely filed this dispute in error — currency confusion, wanting a booking amendment, etc. The right next step is to contact the customer directly to clarify intent, offer the booking change they may have wanted, and request they withdraw the dispute with their issuing bank. Submit a rebuttal only if they refuse and the event date passes.`,
      tone: 'pre-event',
    };
  }

  // 12.x processing-error codes — currency / amount / duplicate / paid-by-
  // other-means disputes. Matrix notes (retro #9) explicitly forbid leading
  // with chef attendance or the complaint deadline; the relevant framing is
  // "merchant-currency amount authorised = merchant-currency amount charged".
  const code = String(dispute?.network_reason_code || '').trim();
  if (/^12\.\d/.test(code)) {
    return {
      headline: 'NO AMOUNT DISCREPANCY — MERCHANT-CURRENCY AUTHORISED = MERCHANT-CURRENCY CHARGED',
      detail: 'The cardholder authorised the exact amount that was charged, in the merchant\'s billing currency, at checkout. Any difference the cardholder observes on their bank statement is the issuing bank\'s foreign-exchange conversion to their home currency — a bank-side action, not merchant pricing. yhangry\'s pricing is denominated and disclosed in the merchant currency throughout the booking and checkout flow (see embedded checkout screenshot).',
      tone: 'strong',
    };
  }

  // Customer cancelled before the event. This takes precedence over the
  // deadline / no-complaint banners below, which read as misleading here — the
  // customer plainly DID engage (they cancelled and emailed for a refund), so
  // "no complaint lodged" contradicts our own exhibits. Lead instead on the
  // conscious, legitimate booking (which kills "unrecognized") + the
  // contractual late-cancellation charge.
  if (analysis.chef_attendance_assessment === 'EVENT_CANCELLED_BY_CUSTOMER') {
    return {
      headline: 'CARDHOLDER KNOWINGLY MADE THIS BOOKING, THEN CANCELLED LATE — VALID CANCELLATION CHARGE',
      detail: 'This is a legitimate booking the cardholder consciously created — they personally requested the chef, agreed the menu and confirmed the booking on the yhangry platform, which directly refutes the "unrecognized" claim. They then cancelled within yhangry\'s no-refund window, so the amount charged is the contractual late-cancellation fee under the agreed booking terms (not payment for a delivered event); the chef had already incurred ingredient and prep costs that the fee covers.',
      tone: 'strong',
    };
  }

  // Chef attended but the customer was a no-show / failed to provide access.
  // No service occurred, so do NOT claim service delivery — lead on the
  // cardholder's own absence (they caused the non-delivery). Takes precedence
  // over the deadline banners (the deadline is only a secondary point here).
  if (analysis.chef_attendance_assessment === 'CUSTOMER_NO_SHOW') {
    return {
      headline: 'CARDHOLDER WAS NOT PRESENT TO RECEIVE THE BOOKED SERVICE',
      detail: "The chef travelled to the venue and was ready to perform at the agreed time, but the cardholder was not present and did not provide access — confirmed by the cardholder's own messages — so the booked event could not go ahead. The non-delivery was the cardholder's own doing, not a merchant failure; the chef attended and incurred costs for the abandoned booking.",
      tone: 'strong',
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

// Whether to include the chef↔customer chat history in the merchant
// response PDF. For 12.x processing-error codes the conversation is
// irrelevant (amount/currency disputes turn on the receipt, not the menu
// chat). For 13.x (not-as-described) and fraud codes the chat is directly
// material — it proves engagement, service description agreement, etc.
//
// Also gated off when the agent has detected a customer admission. The
// admission is the case's leading argument; the rest of the chat thread
// just clutters the submission and pulls reviewer attention away from
// the smoking-gun quote. Added 2026-05-20 after the Khushbu Aggarwal
// submission included 5 pages of menu negotiation on an admission case.
function shouldIncludePlatformMessages(dispute, analysis) {
  if (analysis?.customer_admission_detected) return false;
  const code = String(dispute?.network_reason_code || '').trim();
  if (/^12\.\d/.test(code)) return false;
  return true;
}

// Auto "payment authentication" exhibit gating. Include it only when it HELPS
// (CVC actually passed) AND the dispute turns on recognition/authorisation —
// an unrecognized/fraud reason, a fraud network code, a customer-initiated
// rebuttal, or a customer-cancelled booking (often filed as "unrecognized").
// Never on ACCEPT (no submission is built) or when CVC did not pass.
const PAYMENT_AUTH_FRAUD_CODES = new Set(['10.4', '4837', '4863']);
function shouldIncludePaymentAuth(dispute, analysis, paymentAuth) {
  if (!paymentAuth || paymentAuth.cvcCheck !== 'pass') return false;
  if (analysis?.recommendation === 'ACCEPT') return false;
  const reason = String(dispute?.reason || '').toLowerCase();
  const code = String(dispute?.network_reason_code || '').trim();
  return (
    reason === 'unrecognized' || reason === 'fraudulent' ||
    PAYMENT_AUTH_FRAUD_CODES.has(code) ||
    analysis?.rebuttal_strategy === 'CUSTOMER_INITIATED' ||
    analysis?.chef_attendance_assessment === 'EVENT_CANCELLED_BY_CUSTOMER'
  );
}

// Split a free-text exhibit description into a document name and a
// "what it proves" clause. Accepts multiple separator styles so ops can
// use whatever's easiest to type:
//   1. em-dash with spaces: "Receipt — £520 GBP charged"
//   2. double-hyphen with spaces: "Receipt -- £520 GBP charged"
//   3. colon with space: "Receipt: £520 GBP charged"
// If none match, the whole text becomes the document name and proves is
// empty. The modal hint tells ops about these formats.
function splitExhibitDescription(text) {
  const s = (text || '').trim();
  if (!s) return { document: '', proves: '' };
  const patterns = [
    /^(.+?)\s+—\s+(.+)$/,   // em-dash
    /^(.+?)\s+--\s+(.+)$/,  // double-hyphen
    /^(.+?):\s+(.+)$/,      // colon
  ];
  for (const p of patterns) {
    const m = s.match(p);
    if (m) return { document: m[1].trim(), proves: m[2].trim() };
  }
  return { document: s, proves: '' };
}

// Auto-generated "payment authentication" exhibit — a clean panel built from the
// Stripe charge's CVC/AVS check results (no screenshot needed). When the checks
// passed, this is the strongest single rebuttal to an "unrecognized" claim.
const PAYMENT_AUTH_CARD_BRANDS = { amex: 'American Express', visa: 'Visa', mastercard: 'Mastercard', discover: 'Discover', diners: 'Diners Club', jcb: 'JCB', unionpay: 'UnionPay' };
function fmtAuthCheck(v) {
  if (v === 'pass') return 'Passed';
  if (v === 'fail') return 'Failed';
  return 'Not provided';
}
function drawPaymentAuthPage(doc, letter, pa) {
  doc.addPage();
  exhibitHeading(doc,
    letter ? `Exhibit ${letter}` : 'Payment Authentication',
    'Card-verification results recorded by Stripe at the time of payment.'
  );
  const brand = PAYMENT_AUTH_CARD_BRANDS[pa.brand] || (pa.brand ? String(pa.brand).toUpperCase() : 'Card');
  const rows = [['Card', `${brand}${pa.last4 ? ` •••• ${pa.last4}` : ''}`]];
  rows.push(['CVC (security code) check', fmtAuthCheck(pa.cvcCheck)]);
  rows.push(['Billing postcode (AVS) check', fmtAuthCheck(pa.postalCheck)]);
  if (pa.line1Check === 'pass' || pa.line1Check === 'fail') rows.push(['Billing address check', fmtAuthCheck(pa.line1Check)]);
  if (pa.ownerName) rows.push(['Cardholder', pa.ownerName]);
  if (pa.ownerEmail) rows.push(['Cardholder email', pa.ownerEmail]);
  if (pa.country) rows.push(['Issuer country', pa.country]);

  const x = 50, w = 495, rowH = 26, labelW = 220;
  let y = doc.y + 4;
  for (const [label, value] of rows) {
    doc.rect(x, y, w, rowH).fill(GREY_BG);
    doc.lineWidth(0.5).strokeColor(GREY_BORDER).rect(x, y, w, rowH).stroke();
    doc.fillColor(GREY_TEXT).fontSize(9).font('Helvetica').text(label, x + 10, y + 8, { width: labelW - 14 });
    const passed = /check$/.test(label) && value === 'Passed';
    doc.fillColor(passed ? GREEN_DARK : NAVY).fontSize(9).font('Helvetica-Bold').text(value, x + labelW, y + 8, { width: w - labelW - 10 });
    y += rowH;
  }
  doc.fillColor('#000000').strokeColor('#000000').lineWidth(1);
  doc.y = y + 14;
  doc.fontSize(9).font('Helvetica').fillColor('#000000').text(
    "The card's security code (CVC) and billing postcode were entered correctly and verified by the issuer at the time of payment — confirming a deliberate, authenticated transaction by the cardholder, and directly rebutting any claim that the charge was unrecognised or unauthorised.",
    x, doc.y, { width: w, align: 'left' }
  );
}

// Build the unified list of exhibits that will appear in this PDF, in
// render order. Each item is given a sequential letter (A, B, C, ...) and
// the same letter is used both in the page-1 Evidence table and on the
// exhibit's own page header.
//
// Order:
//   1. Platform messages (when included)
//   2. Click-to-accept screenshot (when applicable)
//   3. Inbound contact log (when present)
//   4. User-uploaded exhibits
function buildAttachedExhibitList({ dispute, analysis, platformMessages, allContacts, exhibits, paymentAuth }) {
  const items = [];
  const isCancelled = analysis?.chef_attendance_assessment === 'EVENT_CANCELLED_BY_CUSTOMER';
  const hasUploads = (exhibits || []).some((ex) => ex?.source);

  // 1. Auto-rendered platform-messages chat. Suppressed when ops has uploaded
  //    their own exhibits — the uploads are the curated, higher-quality version
  //    and the auto-render just duplicates the same conversation (Aki feedback
  //    2026-06-04: "why exhibit A when the same is shown via screenshots in B?").
  if (shouldIncludePlatformMessages(dispute, analysis) && !hasUploads && platformMessages && platformMessages.length > 0) {
    items.push({
      kind: 'platform_messages',
      document: 'Platform messages',
      proves: `${platformMessages.length} messages between the chef and customer on the yhangry platform around the booking.`,
    });
  }

  // 2. Ops-curated uploaded exhibits — the primary evidence, lettered first.
  (exhibits || []).forEach((ex) => {
    if (!ex?.source) return;
    const { document, proves } = splitExhibitDescription(ex.description || '');
    items.push({
      kind: 'user_upload',
      document: document || 'Uploaded evidence',
      proves,
      source: ex.source,
    });
  });

  // 2b. Auto payment-authentication panel (CVC/AVS passed) — strong recognition
  //     proof for unrecognized / fraud / customer-initiated cases. No upload needed.
  if (shouldIncludePaymentAuth(dispute, analysis, paymentAuth)) {
    items.push({
      kind: 'payment_auth',
      document: 'Stripe payment authentication',
      proves: "The card's CVC (security code) and billing-postcode checks passed at payment — a deliberate, authenticated transaction by the cardholder, not an unrecognised charge.",
    });
  }

  // 3. Inbound contact log (when present).
  if (allContacts && allContacts.length > 0) {
    items.push({
      kind: 'contact_log',
      document: 'Inbound contact log',
      proves: `${allContacts.length} inbound contact attempts across Aircall, Bird, and Conduit channels from event date onwards.`,
    });
  }

  // 4. Policy screenshots as supporting exhibits (last). Always included for
  //    cancelled-then-charged disputes (isCancelled): the checkout screenshot
  //    proves the customer agreed to the booking terms, and the cancellation-
  //    terms screenshot proves the no-refund policy they are bound by.
  if (shouldEmbedCheckoutScreenshot(dispute) || isCancelled) {
    items.push({
      kind: 'checkout',
      document: 'yhangry checkout screenshot',
      proves: 'Booking terms, privacy policy, and merchant-currency pricing are surfaced at checkout; acceptance is required before payment.',
    });
  }

  if (shouldEmbedCancellationTermsScreenshot(dispute) || isCancelled) {
    items.push({
      kind: 'cancellation_terms',
      document: 'yhangry booking terms — cancellation policy',
      proves: 'Cancellation/refund clauses the customer agreed to at checkout (yhangry.com/booking-terms): 100% cancellation fee within 7 days of booking time, no refund after Grace Period.',
    });
  }

  items.forEach((it, i) => {
    it.letter = String.fromCharCode(65 + i); // A, B, C, ...
  });

  return items;
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
  const headlineH = doc.heightOfString(`${callout.headline}`, { width: w - padding * 2 });
  doc.fontSize(9).font('Helvetica');
  const detailH = doc.heightOfString(callout.detail, { width: w - padding * 2 });
  const totalH = padding + headlineH + 4 + detailH + padding;

  doc.lineWidth(1.5);
  doc.roundedRect(x, startY, w, totalH, 4).fillAndStroke(t.bg, t.border);
  doc.lineWidth(1);

  doc.fillColor(t.text).fontSize(11).font('Helvetica-Bold')
    .text(`${callout.headline}`, x + padding, startY + padding, { width: w - padding * 2 });

  doc.fillColor('#000000').fontSize(9).font('Helvetica')
    .text(callout.detail, x + padding, doc.y + 2, { width: w - padding * 2 });

  doc.fillColor('#000000');
  doc.y = startY + totalH + 10;
}

// Currency-aware money formatting. The TRANSACTION cell previously hardcoded
// "$", so GBP (UK-account) disputes mis-rendered as dollars (e.g. a £50 charge
// showed "$50.00"). Derive the symbol from the dispute's actual currency.
const CURRENCY_SYMBOLS = { usd: '$', gbp: '£', eur: '€', aud: 'A$', cad: 'C$' };
function formatMoney(amountMinor, currency) {
  const cur = String(currency || '').toLowerCase();
  const amt = (Number(amountMinor || 0) / 100).toFixed(2);
  const sym = CURRENCY_SYMBOLS[cur];
  return sym ? `${sym}${amt}` : `${amt} ${cur.toUpperCase()}`.trim();
}

function drawFactsGrid(doc, dispute, booking, analysis) {
  // STATUS / recommendation / rebuttal_strategy are internal ops vocabulary
  // (STRONG_COUNTER, CLAIM_BY_CLAIM, etc.) that mean nothing to a bank
  // reviewer — removed from the public-facing grid 2026-05-20. Keep them
  // surfaced in the Slack post + reasoning for ops only.
  const cells = [
    {
      label: 'TRANSACTION',
      value: formatMoney(dispute.amount, dispute.currency),
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

// Render the page-1 Evidence table. Each row corresponds to one of the
// attached exhibits that appears later in the PDF — letters in the table
// match the letters on the exhibit page headers.
//
// Format: 3 columns matching the user-approved Katie Robertson reference:
//   Exhibit | Document | Proves
function drawEvidenceTable(doc, attachedExhibits) {
  drawSectionHeading(doc, 'Evidence');

  if (!attachedExhibits || attachedExhibits.length === 0) {
    doc.fontSize(9).font('Helvetica-Oblique').fillColor(GREY_TEXT)
      .text('No exhibits attached. Use the "Upload Evidence" button on the Slack dispute review to attach supporting documents.', 50, doc.y, { width: 495 });
    doc.fillColor('#000000');
    doc.y += 14;
    return;
  }

  const x0 = 50, w = 495;
  const colExhibit = 50;   // "Exhibit A" fits in ~50pt
  const colDocument = 165; // ~165pt for the document name
  const colProves = w - colExhibit - colDocument;

  // Header row
  const headerY = doc.y;
  doc.rect(x0, headerY, w, 18).fill(NAVY);
  doc.fillColor('#FFFFFF').fontSize(8).font('Helvetica-Bold');
  doc.text('EXHIBIT', x0 + 6, headerY + 5, { width: colExhibit - 12 });
  doc.text('DOCUMENT', x0 + colExhibit, headerY + 5, { width: colDocument - 6 });
  doc.text('PROVES', x0 + colExhibit + colDocument, headerY + 5, { width: colProves - 6 });
  doc.fillColor('#000000');
  doc.y = headerY + 18;

  attachedExhibits.forEach((item, i) => {
    const rowMinH = 22;
    checkPageSpace(doc, rowMinH + 6);

    // Measure tallest of the two text columns to set row height
    doc.fontSize(8).font('Helvetica');
    const docH = doc.heightOfString(item.document || '', { width: colDocument - 12 });
    const provesH = doc.heightOfString(item.proves || '', { width: colProves - 12 });
    const rowH = Math.max(rowMinH, Math.max(docH, provesH) + 10);

    const rowY = doc.y;
    doc.rect(x0, rowY, w, rowH).fill(i % 2 === 0 ? GREY_BG : '#FFFFFF');
    doc.lineWidth(0.5).strokeColor(GREY_BORDER).rect(x0, rowY, w, rowH).stroke();

    doc.fillColor('#000000').fontSize(8).font('Helvetica-Bold')
      .text(item.letter, x0 + 6, rowY + 6, { width: colExhibit - 12 });
    doc.fontSize(8).font('Helvetica')
      .text(item.document || '', x0 + colExhibit, rowY + 6, { width: colDocument - 6 });
    doc.fillColor(GREY_TEXT).fontSize(8).font('Helvetica')
      .text(item.proves || '', x0 + colExhibit + colDocument, rowY + 6, { width: colProves - 6 });
    doc.fillColor('#000000');

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
// Safety-compress ops-uploaded exhibit images before embedding. pdfkit's
// doc.image() embeds the FULL image bytes (the `fit:` option only scales the
// display box), so a few large screenshots can push the PDF over Stripe's 5MB
// evidence limit. Downscale to <=1800px long edge + JPEG q82. Uses sharp via a
// dynamic import wrapped in try/catch so a missing/broken native build on the
// host degrades gracefully to the original image rather than crashing the PDF.
async function compressExhibitImages(exhibits) {
  if (!exhibits || exhibits.length === 0) return exhibits;
  let sharp;
  try { sharp = (await import('sharp')).default; }
  catch (err) { console.warn('[evidence] sharp unavailable, skipping image compression:', err.message); return exhibits; }
  const out = [];
  for (const ex of exhibits) {
    if (!ex?.source) { out.push(ex); continue; }
    try {
      const buf = await sharp(ex.source).rotate()
        .resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82 }).toBuffer();
      out.push({ ...ex, source: buf });
    } catch (err) {
      console.warn('[evidence] image compress failed for one exhibit, using original:', err.message);
      out.push(ex);
    }
  }
  return out;
}

export async function generateEvidence({ analysis, dispute, booking, platformMessages, allContacts, exhibits, paymentAuth }) {
  exhibits = await compressExhibitImages(exhibits);
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const bufferPromise = collectBuffer(doc);

  // ===== PAGE 1: Skimmer-first merchant response summary =====
  // (Tyler retro #8 sub-commit 1)
  // The whole story in one scannable page: header → green BOTTOM-LINE
  // callout → 4-cell facts grid → 3-bullet rebuttal → compact timeline →
  // evidence index with ★-marked strongest item. Designed for a Stripe/bank
  // reviewer's 30-second scan; the exhibit appears highlighted in gold.

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

  // Compact timeline — anchored on deadline-argument events (first complaint
  // contact, T&C deadline). Hidden when the rebuttal hinges on a customer
  // admission, since the deadline is moot in that framing — the BOTTOM_LINE
  // callout already gives the punchline and rebuttal bullets carry the
  // narrative. Added 2026-05-20 after the Khushbu Aggarwal PDF showed a
  // deadline-focused timeline on an admission-driven case.
  // Skip the deadline-anchored timeline for admission cases (deadline is moot)
  // and for cancellation cases (its "first complaint contact / T&C deadline"
  // framing is misleading when the dispute is about a late cancellation, not a
  // post-event complaint — and it omits the actual cancellation event).
  if (!analysis.customer_admission_detected &&
      analysis.chef_attendance_assessment !== 'EVENT_CANCELLED_BY_CUSTOMER') {
    drawCompactTimeline(doc, analysis, dispute, booking);
  }

  // Build the unified list of attached exhibits in render order. Letters
  // assigned here are reused on each exhibit's page header so the page-1
  // Evidence table corresponds exactly to what the reviewer sees later.
  const attachedExhibits = buildAttachedExhibitList({
    dispute, analysis, platformMessages, allContacts, exhibits, paymentAuth,
  });

  // Page-1 Evidence table — lists actual attached exhibits with letters
  drawEvidenceTable(doc, attachedExhibits);

  // ===== Exhibit pages =====
  // Iterate the unified list and render each section using its assigned
  // letter. This guarantees the page-1 table and the page headers stay
  // in sync.
  for (const item of attachedExhibits) {
    if (item.kind === 'platform_messages') {
      doc.addPage();
      exhibitHeading(doc,
        `Exhibit ${item.letter}`,
        `Platform Messages — yhangry Booking #${analysis.booking_id || booking.order_id} — messages between chef and customer`
      );
      for (const m of platformMessages) {
        drawChatBubble(doc, m);
      }
    } else if (item.kind === 'checkout') {
      drawCheckoutScreenshotPage(doc, item.letter);
    } else if (item.kind === 'cancellation_terms') {
      drawCancellationTermsPage(doc, item.letter);
    } else if (item.kind === 'contact_log') {
      doc.addPage();
      exhibitHeading(doc,
        `Exhibit ${item.letter}`,
        `Inbound Contact Log — customer phone ${booking.customer_phone || 'n/a'}, all channels from event date onwards`
      );
      drawCallLogTable(doc, allContacts);
    } else if (item.kind === 'user_upload') {
      const subtitle = item.proves ? `${item.document} — ${item.proves}` : item.document;
      drawImageExhibitPage(doc, { label: item.letter, description: subtitle, source: item.source });
    } else if (item.kind === 'payment_auth') {
      drawPaymentAuthPage(doc, item.letter, paymentAuth);
    }
  }

  doc.end();
  return await bufferPromise;
}
