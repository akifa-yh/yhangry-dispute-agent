import PDFDocument from 'pdfkit';

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

// Backwards-compat: handle old string-form evidence entries
function normaliseEvidence(item) {
  if (typeof item === 'string') {
    return { evidence: item, independence_score: null, rationale: null };
  }
  return {
    evidence: item.evidence || '',
    independence_score: item.independence_score || null,
    rationale: item.rationale || null,
  };
}

const INDEPENDENCE_BADGE = {
  HIGH: { label: 'HIGH', fill: '#2E7D32', text: '#FFFFFF' },     // green
  MEDIUM: { label: 'MEDIUM', fill: '#1565C0', text: '#FFFFFF' }, // blue
  LOW: { label: 'LOW', fill: '#F9A825', text: '#000000' },       // amber
};

const SEVERITY_BADGE = {
  LOW: { label: 'LOW', fill: '#9E9E9E', text: '#FFFFFF' },
  MEDIUM: { label: 'MEDIUM', fill: '#F57C00', text: '#FFFFFF' },
  HIGH: { label: 'HIGH', fill: '#D32F2F', text: '#FFFFFF' },
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

function sectionHeading(doc, text, subtitle) {
  checkPageSpace(doc, 60);
  doc.fontSize(12).font('Helvetica-Bold').fillColor('#000000').text(text, 50);
  if (subtitle) {
    doc.fontSize(8).font('Helvetica-Oblique').fillColor('#666666').text(subtitle, 50);
    doc.fillColor('#000000');
  }
  doc.moveDown(0.5);
}

function formatMessageTimestamp(raw) {
  // BigQuery timestamps come back as { value: 'ISO string' } objects
  const s = raw?.value || raw;
  if (!s) return '';
  // Render as 'YYYY-MM-DD HH:MM' for compactness
  const str = String(s);
  return str.includes('T') ? str.replace('T', ' ').slice(0, 16) : str.slice(0, 16);
}

function senderDisplayName(message) {
  // Both customer_first_name and chef_first_name are always populated
  // (they identify conversation parties, not who sent the message).
  // Pick based on sender_role.
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

  // Timestamp label
  doc.fontSize(7).font('Helvetica').fillColor('#999999')
    .text(`${time} — ${sender} (${name})`, x, doc.y, { width: maxWidth });

  // Measure text height for bubble
  const bubbleY = doc.y;
  const textHeight = doc.heightOfString(body, { width: maxWidth - 20, fontSize: 9 });
  const bubbleHeight = textHeight + 14;

  // Draw bubble
  doc.roundedRect(x, bubbleY, maxWidth, bubbleHeight, 8)
    .fillAndStroke(bubbleColor, '#E0E0E0');

  // Draw text inside bubble
  doc.fontSize(9).font('Helvetica').fillColor('#000000')
    .text(body, x + 10, bubbleY + 7, { width: maxWidth - 20 });

  doc.y = bubbleY + bubbleHeight + 8;
}

function drawCallLogTable(doc, contacts) {
  if (!contacts || contacts.length === 0) return;

  const tableX = 50;

  // Header row
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

  // Data rows
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

export async function generateEvidence({ analysis, dispute, booking, platformMessages, allContacts }) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const bufferPromise = collectBuffer(doc);

  const amount = (dispute.amount / 100).toFixed(2);

  // ===== PAGE 1: Title + Case Summary =====
  doc.fontSize(16).font('Helvetica-Bold')
    .text(`Dispute Evidence — ${analysis.dispute_id}`, { align: 'center' });
  doc.fontSize(9).font('Helvetica-Oblique')
    .text(`Generated: ${new Date().toISOString()} | yhangry Dispute Agent`, { align: 'center' });
  doc.moveDown(1.5);

  // Case Summary Box
  const summaryRows = [
    ['Dispute ID', analysis.dispute_id],
    ['Booking ID', String(analysis.booking_id)],
    ['Amount', `$${amount}`],
    ['Dispute Reason', `${dispute.reason} (${dispute.network_reason_code || 'N/A'})`],
    ['Event Date', String(booking.event_date)],
    ['Customer', `${booking.first_name} ${booking.last_name} (${booking.customer_email})`],
    ['Chef', `${booking.chef_first_name} ${booking.chef_last_name}`],
    ['Guests', String(booking.number_of_guests)],
    ['Address', `${booking.address_line1 || ''}, ${booking.address_postcode || ''}`],
    ['Chef Marked Ready', String(booking.is_chef_ready_response)],
    ['Chef Marked On Time', String(booking.is_chef_on_time_response)],
    ['Chef Submitted Survey', String(booking.chef_submitted_payment_survey || false)],
    ['Complaint Deadline', analysis.deadline_iso],
    ['Deadline Status', analysis.deadline_status],
    ['Chef Attendance', analysis.chef_attendance_assessment],
    ['Recommendation', `${analysis.recommendation} | Evidence: ${analysis.evidence_strength}`],
  ];

  // Calculate box height
  const lineHeight = 14;
  const boxHeight = summaryRows.length * lineHeight + 30;
  const boxY = doc.y;

  doc.roundedRect(50, boxY, 495, boxHeight, 5).fillAndStroke('#F5F5F5', '#CCCCCC');
  doc.fill('#000000');

  doc.fontSize(11).font('Helvetica-Bold').text('Case Summary', 60, boxY + 10);
  doc.moveDown(0.2);

  doc.fontSize(9).font('Helvetica');
  for (const [label, value] of summaryRows) {
    doc.font('Helvetica-Bold').text(`${label}: `, 60, doc.y, { continued: true });
    doc.font('Helvetica').text(value || 'N/A');
  }

  doc.y = boxY + boxHeight + 15;

  // Lookup map for resolving claim_id → claim text in claim_analysis & weaknesses
  const customerClaims = analysis.customer_claims || [];
  const claimsById = Object.fromEntries(customerClaims.map((c) => [c.id, c]));
  const narrativeProvided = analysis.narrative_provided === true;

  // ===== Customer Claims (Extracted from VROL) =====
  // Only renders if narrative was provided. Pre-narrative analyses have an
  // empty customer_claims array and skip this entire section.
  if (narrativeProvided && customerClaims.length > 0) {
    sectionHeading(doc, `Customer Claims (${customerClaims.length})`,
      'Extracted from the customer\'s VROL questionnaire narrative');
    doc.fontSize(9).font('Helvetica');

    customerClaims.forEach((c, i) => {
      checkPageSpace(doc, 40);
      const num = i + 1;
      const cat = c.category ? ` [${c.category}]` : '';
      doc.font('Helvetica-Bold').text(`${num}.${cat} `, 50, doc.y, { continued: true });
      doc.font('Helvetica').text(c.claim || '', { width: 490 });
      doc.moveDown(0.4);
    });
  }

  // ===== Claim Analysis (per-claim evidence mapping) =====
  if (analysis.claim_analysis && analysis.claim_analysis.length > 0) {
    sectionHeading(doc, 'Claim Analysis',
      'Each customer claim mapped to the evidence we have (or do not have)');
    doc.fontSize(9).font('Helvetica');

    for (const ca of analysis.claim_analysis) {
      checkPageSpace(doc, 60);
      const statusColor = ca.status === 'CONTRADICTED' ? '#D32F2F'
        : ca.status === 'SUPPORTED' ? '#F57C00' : '#757575';

      doc.roundedRect(50, doc.y, 495, 12, 2).fill(statusColor);
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#FFFFFF')
        .text(` ${ca.status}`, 55, doc.y - 10);
      doc.fillColor('#000000');

      // Resolve claim text from customer_claims by id; fall back to claim_id
      const claim = claimsById[ca.claim_id];
      const claimText = claim?.claim || ca.claim_id || '(claim text missing)';

      doc.fontSize(9).font('Helvetica-Oblique')
        .text(`"${claimText}"`, 50, doc.y + 4, { width: 490 });
      const indepTag = ca.evidence_independence ? ` [${ca.evidence_independence}]` : '';
      doc.font('Helvetica')
        .text(`Evidence${indepTag}: ${ca.evidence || 'no evidence available'}`, 50, doc.y, { width: 490 });
      doc.moveDown(0.5);
    }
  } else if (narrativeProvided) {
    sectionHeading(doc, 'Claim Analysis');
    doc.fontSize(9).font('Helvetica').text('No claims extracted from narrative.', 50, doc.y, { width: 490 });
  } else {
    sectionHeading(doc, 'Claim Analysis');
    doc.fontSize(9).font('Helvetica-Oblique').fillColor('#666666')
      .text('Customer narrative not yet provided. Per-claim mapping is unlocked once ops pastes the VROL questionnaire via the Slack "Add Customer Narrative" button.', 50, doc.y, { width: 490 });
    doc.fillColor('#000000');
  }

  // ===== Unaddressed Allegations =====
  const unaddressed = analysis.unaddressed_claims || [];
  if (unaddressed.length > 0) {
    sectionHeading(doc, 'Unaddressed Allegations',
      'Customer claims for which we have no available evidence — prepare manually or escalate');
    doc.fontSize(9).font('Helvetica');

    unaddressed.forEach((u, i) => {
      checkPageSpace(doc, 40);
      const claim = claimsById[u.claim_id];
      const claimText = u.claim || claim?.claim || u.claim_id;
      doc.font('Helvetica-Bold').text(`${i + 1}. `, 50, doc.y, { continued: true });
      doc.font('Helvetica-Oblique').text(`"${claimText}"`, { width: 490 });
      doc.font('Helvetica').fillColor('#666666')
        .text(`Why unaddressed: ${u.why_unaddressed || ''}`, 50, doc.y, { width: 490 });
      doc.fillColor('#000000');
      doc.moveDown(0.4);
    });
  }

  // ===== Rebuttal Points =====
  sectionHeading(doc, 'Rebuttal Points');
  doc.fontSize(9).font('Helvetica');
  if (analysis.suggested_rebuttal_points && analysis.suggested_rebuttal_points.length > 0) {
    analysis.suggested_rebuttal_points.forEach((point, i) => {
      checkPageSpace(doc, 30);
      doc.text(`${i + 1}. ${point}`, 50, doc.y, { width: 490 });
      doc.moveDown(0.3);
    });
  } else {
    doc.text('None.');
  }

  // ===== Reasoning =====
  sectionHeading(doc, 'Analysis Reasoning');
  doc.fontSize(9).font('Helvetica');
  doc.text(analysis.reasoning || 'N/A', 50, doc.y, { width: 490 });

  // ===== PAGE 2+: Platform Messages (Chat Bubbles) =====
  doc.addPage();
  sectionHeading(doc,
    `Platform Messages — yhangry Booking #${analysis.booking_id}`,
    'Messages between chef and customer on the yhangry platform'
  );

  if (platformMessages && platformMessages.length > 0) {
    for (const m of platformMessages) {
      drawChatBubble(doc, m);
    }
  } else {
    doc.fontSize(9).font('Helvetica').text('No platform messages available.');
  }

  // ===== Contact Log (Aircall / Bird / Conduit) =====
  if (allContacts && allContacts.length > 0) {
    doc.addPage();
    sectionHeading(doc,
      'Inbound Contact Log',
      `Customer phone: ${booking.customer_phone} | All channels from event date onwards`
    );
    drawCallLogTable(doc, allContacts);
  }

  // ===== Evidence to Include (with independence scores) =====
  const evidenceItems = (analysis.evidence_to_include || []).map(normaliseEvidence);
  if (evidenceItems.length > 0) {
    doc.moveDown(1);
    sectionHeading(doc, 'Evidence to Include',
      'Independence-scored. HIGH = system-recorded, MEDIUM = customer-party messages, LOW = chef self-report.');

    evidenceItems.forEach((item, i) => {
      checkPageSpace(doc, 50);
      const rowY = doc.y;

      // Number + badge
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#000000')
        .text(`${i + 1}.`, 50, rowY, { continued: false, width: 18 });

      const badge = INDEPENDENCE_BADGE[item.independence_score];
      const badgeWidth = badge ? drawBadge(doc, 68, rowY + 1, badge) : 0;
      const textX = 68 + (badgeWidth ? badgeWidth + 6 : 0);

      doc.fontSize(9).font('Helvetica').fillColor('#000000')
        .text(item.evidence, textX, rowY, { width: 545 - textX });

      if (item.rationale) {
        doc.fontSize(8).font('Helvetica-Oblique').fillColor('#666666')
          .text(item.rationale, 68, doc.y + 1, { width: 477 });
        doc.fillColor('#000000');
      }
      doc.moveDown(0.4);
    });
  }

  // ===== Evidence Weaknesses & Gaps =====
  const weaknesses = analysis.evidence_weaknesses || [];
  if (weaknesses.length > 0) {
    doc.moveDown(0.5);
    sectionHeading(doc, 'Evidence Weaknesses & Gaps',
      'Items NOT to include in submitted evidence. Flagged so reviewer is aware of vulnerabilities in our case.');

    weaknesses.forEach((w, i) => {
      checkPageSpace(doc, 50);
      const rowY = doc.y;

      doc.fontSize(9).font('Helvetica-Bold').fillColor('#000000')
        .text(`${i + 1}.`, 50, rowY, { continued: false, width: 18 });

      const badge = SEVERITY_BADGE[w.severity];
      const badgeWidth = badge ? drawBadge(doc, 68, rowY + 1, badge) : 0;
      const textX = 68 + (badgeWidth ? badgeWidth + 6 : 0);

      doc.fontSize(9).font('Helvetica').fillColor('#000000')
        .text(w.weakness || '', textX, rowY, { width: 545 - textX });

      if (w.affects_claim) {
        doc.fontSize(8).font('Helvetica-Oblique').fillColor('#666666')
          .text(`Affects claim: ${w.affects_claim}`, 68, doc.y + 1, { width: 477 });
        doc.fillColor('#000000');
      }
      doc.moveDown(0.4);
    });
  }

  // ===== Evidence Requirements Check =====
  // What does this dispute code actually need to win at the bank, and
  // what do we have? Only renders when applicable (we have a playbook
  // entry for this network/reason_code).
  const reqCheck = analysis.evidence_requirements_check;
  if (reqCheck && reqCheck.applicable) {
    doc.moveDown(0.5);
    const subtitle = reqCheck.code_label
      ? `Bank evidence requirements for ${reqCheck.code_label}.`
      : 'Bank evidence requirements for this dispute code.';
    sectionHeading(doc, 'Evidence Requirements Check', subtitle);

    function drawReqRow(item, sectionLabel) {
      checkPageSpace(doc, 40);
      const rowY = doc.y;
      const isMissing = item.status === 'MISSING';
      const statusBadge = isMissing
        ? { label: 'MISSING', fill: '#D32F2F', text: '#FFFFFF' }
        : { label: 'PRESENT', fill: '#2E7D32', text: '#FFFFFF' };
      const badgeWidth = drawBadge(doc, 50, rowY + 1, statusBadge);
      const textX = 50 + badgeWidth + 6;
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#000000')
        .text(item.type || '', textX, rowY, { width: 545 - textX });
      if (item.evidence) {
        doc.fontSize(8).font('Helvetica-Oblique').fillColor('#666666')
          .text(item.evidence, 50, doc.y + 1, { width: 495 });
        doc.fillColor('#000000');
      }
      doc.moveDown(0.35);
    }

    if ((reqCheck.required || []).length > 0) {
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#000000')
        .text('Required:', 50, doc.y, { width: 495 });
      doc.moveDown(0.15);
      reqCheck.required.forEach((r) => drawReqRow(r, 'required'));
    }

    if ((reqCheck.strengthening || []).length > 0) {
      doc.moveDown(0.2);
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#000000')
        .text('Strengthening:', 50, doc.y, { width: 495 });
      doc.moveDown(0.15);
      reqCheck.strengthening.forEach((r) => drawReqRow(r, 'strengthening'));
    }

    if (reqCheck.missing_required_count > 0) {
      doc.moveDown(0.3);
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#D32F2F')
        .text(
          `${reqCheck.missing_required_count} required item${reqCheck.missing_required_count === 1 ? '' : 's'} missing — strengthen the case manually before submission, or escalate.`,
          50, doc.y, { width: 495 }
        );
      doc.fillColor('#000000');
    }

    if (reqCheck.summary) {
      doc.moveDown(0.3);
      doc.fontSize(9).font('Helvetica-Oblique').fillColor('#444444')
        .text(reqCheck.summary, 50, doc.y, { width: 495 });
      doc.fillColor('#000000');
    }
  }

  // ===== Flags =====
  if (analysis.flags && analysis.flags.length > 0) {
    doc.moveDown(0.5);
    sectionHeading(doc, 'Flags for Human Attention');
    doc.fontSize(9).font('Helvetica');
    analysis.flags.forEach((f) => {
      doc.text(`• ${f}`, 50, doc.y, { width: 490 });
      doc.moveDown(0.2);
    });
  }

  doc.end();
  return await bufferPromise;
}
