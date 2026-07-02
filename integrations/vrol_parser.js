import { PDFParse } from 'pdf-parse';

/**
 * Parse a Visa Resolve Online (VROL) PDF.
 *
 * The VROL form is a Visa-controlled, structured PDF that the issuing bank
 * fills in when a cardholder disputes a transaction. It is the authoritative
 * source for the network reason code — Stripe's webhook `network_reason_code`
 * field is sometimes unreliable until the issuer files VROL.
 *
 * For 13.x (not-as-described) cases the VROL typically has a free-text
 * "Comments" field with the cardholder's narrative. For 12.x (processing
 * error) cases the form is mostly structured fields and the Comments field
 * is empty — for those, we synthesize a one-paragraph narrative from the
 * structured fields so Gemini still has something to analyse.
 *
 * Tyler retro #10 (2026-05-14).
 *
 * @param {Buffer} buffer - the VROL PDF bytes
 * @returns {Promise<{
 *   caseNumber: string|null,
 *   reasonCode: string|null,
 *   transactionAmount: number|null,
 *   transactionCurrency: string|null,
 *   disputeAmount: number|null,
 *   disputeCurrency: string|null,
 *   whatIsIncorrect: string|null,
 *   cardholderReceiptAmount: string|null,
 *   comments: string|null,
 *   narrative: string,
 *   rawText: string,
 * }>}
 */
export async function parseVrolPdf(buffer) {
  const parser = new PDFParse({ data: buffer });
  const result = await parser.getText();
  const text = (result.text || '').trim();

  if (!text) {
    throw new Error('VROL PDF returned empty text — is the file a scan / image-only PDF? OCR not currently supported.');
  }

  // Reason code: prefer the explicit "Dispute Category/Condition" field,
  // fall back to any visible network code in the text.
  let reasonCode = null;
  const catMatch = text.match(/Dispute\s+Category(?:\/Condition)?\s*:?\s*(\d{2}\.\d+(?:\.\d+)?|\d{4})/i);
  if (catMatch) {
    reasonCode = catMatch[1];
  } else {
    // Fallback scan of the whole text. This value OVERRIDES the dispute's
    // reason code downstream ("VROL is authoritative"), so it must never be
    // a money amount that happens to look like a code: the old patterns
    // matched "10.40" inside "$310.40" and any 4-digit number like "4500"
    // (GAN review M9). Visa minors are single digits (13.1, 12.6.1), and
    // Mastercard codes are validated against the known chargeback set.
    const MC_KNOWN_CODES = [
      '4807', '4808', '4812', '4831', '4834', '4837', '4841', '4842', '4846',
      '4849', '4853', '4854', '4855', '4859', '4860', '4863', '4870', '4871',
    ];
    const visaAny = text.match(/\b(1[0-3]\.[1-9](?:\.[1-9])?)\b/);
    const mcAny = text.match(new RegExp(`\\b(${MC_KNOWN_CODES.join('|')})\\b`));
    if (visaAny) reasonCode = visaAny[1];
    else if (mcAny) reasonCode = mcAny[1];
  }

  let caseNumber = null;
  const caseMatch = text.match(/VROL\s+Case\s+Number\s+(\d+)/i);
  if (caseMatch) caseNumber = caseMatch[1];

  let transactionAmount = null;
  let transactionCurrency = null;
  const tranMatch = text.match(/Tran(?:saction)?\s+Amount\s*:?\s*([\d,]+\.\d{2})\s+([A-Z]{3})/i);
  if (tranMatch) {
    transactionAmount = parseFloat(tranMatch[1].replace(/,/g, ''));
    transactionCurrency = tranMatch[2];
  }

  let disputeAmount = null;
  let disputeCurrency = null;
  const dispMatch = text.match(/Dispute\s+Amount\s*:?\s*([\d,]+\.\d{2})\s+([A-Z]{3})/i);
  if (dispMatch) {
    disputeAmount = parseFloat(dispMatch[1].replace(/,/g, ''));
    disputeCurrency = dispMatch[2];
  }

  let whatIsIncorrect = null;
  const wiMatch = text.match(/What\s+is\s+incorrect\s+about\s+this\s+transaction\??\s*([^\n]+)/i);
  if (wiMatch) whatIsIncorrect = wiMatch[1].trim();

  let cardholderReceiptAmount = null;
  const crMatch = text.match(/What\s+is\s+the\s+amount\s+on\s+the\s+cardholder'?s?\s+receipt\??\s*([^\n]+)/i);
  if (crMatch) cardholderReceiptAmount = crMatch[1].trim();

  // Free-text Comments field (typically populated for 13.x / 4853 cases,
  // typically empty for 12.x processing-error cases). Require the colon
  // explicitly so we don't match the "Comments and Documents" section
  // header that precedes the actual "Comments:" field.
  let comments = null;
  const cmtMatch = text.match(/\bComments\s*:\s*([^]*?)(?=Documents\s*:|Other\b|Issuer\b|--\s*\d+\s+of\s+\d+|$)/i);
  if (cmtMatch) {
    const c = cmtMatch[1].trim();
    // Sanity check: discard if the capture looks like it picked up another
    // field label (e.g. "and Documents" from the section header).
    const looksLikeBoilerplate = /^(and|or)\s+(Documents|Other)/i.test(c);
    if (c.length > 0 && !looksLikeBoilerplate) comments = c;
  }

  // Build the synthesized narrative that gets fed to Gemini.
  // - If Comments are substantive (>20 chars), use them directly — that's
  //   the cardholder's own account.
  // - Otherwise synthesize a structured one-paragraph narrative from the
  //   form fields. Pattern documented in the #10 design notes in
  //   dispute_agent_state.md.
  let narrative;
  if (comments && comments.length > 20) {
    narrative = comments;
  } else {
    const parts = [];
    if (whatIsIncorrect) {
      parts.push(`Cardholder claims on VROL form: "${whatIsIncorrect}".`);
    }
    if (reasonCode) {
      parts.push(`Dispute filed under reason code ${reasonCode}.`);
    }
    if (transactionAmount != null && transactionCurrency) {
      parts.push(`Transaction was processed for ${transactionAmount} ${transactionCurrency}.`);
    }
    if (cardholderReceiptAmount) {
      parts.push(`Cardholder's receipt cited on VROL as: ${cardholderReceiptAmount}.`);
    }
    if (disputeAmount != null && disputeCurrency) {
      parts.push(`Disputed amount: ${disputeAmount} ${disputeCurrency}.`);
    }
    parts.push('No additional comments or documents provided by cardholder on the VROL form.');
    narrative = parts.join(' ');
  }

  return {
    caseNumber,
    reasonCode,
    transactionAmount,
    transactionCurrency,
    disputeAmount,
    disputeCurrency,
    whatIsIncorrect,
    cardholderReceiptAmount,
    comments,
    narrative,
    rawText: text,
  };
}
