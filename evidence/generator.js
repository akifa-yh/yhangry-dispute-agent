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

function sectionHeading(doc, text, subtitle) {
  checkPageSpace(doc, 60);
  doc.fontSize(12).font('Helvetica-Bold').fillColor('#000000').text(text, 50);
  if (subtitle) {
    doc.fontSize(8).font('Helvetica-Oblique').fillColor('#666666').text(subtitle, 50);
    doc.fillColor('#000000');
  }
  doc.moveDown(0.5);
}

function drawChatBubble(doc, message) {
  const sender = (message.sender_role || 'unknown').toUpperCase();
  const name = message.customer_first_name || message.chef_first_name || 'unknown';
  const body = (message.body || '').slice(0, 400);
  const time = message.created_at;

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

  // ===== Claim Analysis =====
  sectionHeading(doc, 'Claim Analysis');
  doc.fontSize(9).font('Helvetica');

  if (analysis.claim_analysis && analysis.claim_analysis.length > 0) {
    for (const claim of analysis.claim_analysis) {
      checkPageSpace(doc, 50);
      const statusColor = claim.status === 'CONTRADICTED' ? '#D32F2F'
        : claim.status === 'SUPPORTED' ? '#F57C00' : '#757575';

      doc.roundedRect(50, doc.y, 495, 12, 2).fill(statusColor);
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#FFFFFF')
        .text(` ${claim.status}`, 55, doc.y - 10);
      doc.fillColor('#000000');

      doc.fontSize(9).font('Helvetica-Oblique')
        .text(`"${claim.claim}"`, 50, doc.y + 4, { width: 490 });
      doc.font('Helvetica')
        .text(`Evidence: ${claim.evidence}`, 50, doc.y, { width: 490 });
      doc.moveDown(0.5);
    }
  } else {
    doc.text('No customer claims analysed.');
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

  // ===== Evidence References =====
  if (analysis.evidence_to_include && analysis.evidence_to_include.length > 0) {
    doc.moveDown(1);
    sectionHeading(doc, 'Evidence References');
    doc.fontSize(9).font('Helvetica');
    analysis.evidence_to_include.forEach((ref, i) => {
      doc.text(`${i + 1}. ${ref}`, 50, doc.y, { width: 490 });
      doc.moveDown(0.2);
    });
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
