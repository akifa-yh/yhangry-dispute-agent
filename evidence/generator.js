import PDFDocument from 'pdfkit';

function collectBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

export async function generateEvidence({ analysis, dispute, booking, platformMessages }) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  const bufferPromise = collectBuffer(doc);

  const amount = (dispute.amount / 100).toFixed(2);

  // --- Title ---
  doc.fontSize(18).font('Helvetica-Bold')
    .text(`Dispute Evidence — ${analysis.dispute_id}`, { align: 'center' });
  doc.moveDown(0.3);
  doc.fontSize(10).font('Helvetica-Oblique')
    .text(`Generated: ${new Date().toISOString()}`, { align: 'center' });
  doc.moveDown(1);

  // --- Case Summary ---
  doc.fontSize(14).font('Helvetica-Bold').text('Case Summary');
  doc.moveDown(0.3);
  doc.fontSize(10).font('Helvetica');

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
    ['Recommendation', analysis.recommendation],
    ['Evidence Strength', analysis.evidence_strength],
    ['Chef Attendance', analysis.chef_attendance_assessment],
  ];

  for (const [label, value] of summaryRows) {
    doc.font('Helvetica-Bold').text(`${label}: `, { continued: true });
    doc.font('Helvetica').text(value || 'N/A');
  }
  doc.moveDown(1);

  // --- Claim Analysis ---
  doc.fontSize(14).font('Helvetica-Bold').text('Claim Analysis');
  doc.moveDown(0.3);
  doc.fontSize(10).font('Helvetica');

  if (analysis.claim_analysis && analysis.claim_analysis.length > 0) {
    for (const claim of analysis.claim_analysis) {
      doc.font('Helvetica-Bold').text(`[${claim.status}] `, { continued: true });
      doc.font('Helvetica').text(`"${claim.claim}"`);
      doc.text(`  Evidence: ${claim.evidence}`);
      doc.moveDown(0.3);
    }
  } else {
    doc.text('No customer claims analysed.');
  }
  doc.moveDown(0.5);

  // --- Rebuttal Points ---
  doc.fontSize(14).font('Helvetica-Bold').text('Rebuttal Points');
  doc.moveDown(0.3);
  doc.fontSize(10).font('Helvetica');

  if (analysis.suggested_rebuttal_points && analysis.suggested_rebuttal_points.length > 0) {
    analysis.suggested_rebuttal_points.forEach((point, i) => {
      doc.text(`${i + 1}. ${point}`);
      doc.moveDown(0.2);
    });
  } else {
    doc.text('None.');
  }
  doc.moveDown(0.5);

  // --- Reasoning ---
  doc.fontSize(14).font('Helvetica-Bold').text('Analysis Reasoning');
  doc.moveDown(0.3);
  doc.fontSize(10).font('Helvetica');
  doc.text(analysis.reasoning || 'N/A');
  doc.moveDown(1);

  // --- Platform Message Timeline ---
  doc.addPage();
  doc.fontSize(14).font('Helvetica-Bold').text('Platform Message Timeline');
  doc.moveDown(0.3);
  doc.fontSize(8).font('Helvetica');

  if (platformMessages && platformMessages.length > 0) {
    for (const m of platformMessages) {
      const sender = (m.sender_role || 'unknown').toUpperCase();
      const name = m.customer_first_name || m.chef_first_name || 'unknown';
      const body = (m.body || '').slice(0, 200);
      doc.font('Helvetica-Bold').text(`[${m.created_at}] ${sender} (${name}):`, { continued: false });
      doc.font('Helvetica').text(body);
      doc.moveDown(0.2);

      // Add page if running low on space
      if (doc.y > 700) doc.addPage();
    }
  } else {
    doc.text('No platform messages available.');
  }
  doc.moveDown(0.5);

  // --- Evidence References ---
  if (analysis.evidence_to_include && analysis.evidence_to_include.length > 0) {
    doc.fontSize(14).font('Helvetica-Bold').text('Evidence References');
    doc.moveDown(0.3);
    doc.fontSize(10).font('Helvetica');
    analysis.evidence_to_include.forEach((ref, i) => {
      doc.text(`${i + 1}. ${ref}`);
    });
    doc.moveDown(0.5);
  }

  // --- Flags ---
  if (analysis.flags && analysis.flags.length > 0) {
    doc.fontSize(14).font('Helvetica-Bold').text('Flags for Human Attention');
    doc.moveDown(0.3);
    doc.fontSize(10).font('Helvetica');
    analysis.flags.forEach((f) => doc.text(`• ${f}`));
  }

  doc.end();
  return await bufferPromise;
}
