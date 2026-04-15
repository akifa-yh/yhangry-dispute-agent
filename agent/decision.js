const RECOMMENDATION_EMOJI = {
  STRONG_COUNTER: ':white_check_mark:',
  COUNTER_WITH_CAVEATS: ':warning:',
  ESCALATE: ':red_circle:',
};

const CLAIM_EMOJI = {
  CONTRADICTED: ':x:',
  SUPPORTED: ':warning:',
  UNVERIFIABLE: ':wavy_dash:',
};

const ATTENDANCE_EMOJI = {
  CONFIRMED: ':white_check_mark:',
  LIKELY: ':large_blue_circle:',
  UNCONFIRMED: ':question:',
  NO_SHOW: ':rotating_light:',
};

function formatDeadline(analysis) {
  const { deadline_status, earliest_contact } = analysis;
  const ec = earliest_contact || {};

  if (deadline_status === 'NO_COMPLAINT_FOUND') {
    return ':no_entry_sign: No contact found on any channel';
  }

  const mins = ec.minutes_relative_to_deadline;
  const absMins = Math.abs(mins || 0);
  const contactInfo = `First contact: ${ec.channel || 'N/A'} ${ec.type || 'N/A'} at ${ec.timestamp_iso || 'N/A'}`;

  if (deadline_status === 'LATE_COMPLAINT') {
    return `:clock1: Late \u2014 ${absMins} mins after deadline\n${contactInfo}`;
  }

  return `:white_check_mark: Timely \u2014 ${absMins} mins before deadline\n${contactInfo}`;
}

export function formatSlackMessage(analysis, dispute, booking) {
  const amount = (dispute.amount / 100).toFixed(2);
  const recEmoji = RECOMMENDATION_EMOJI[analysis.recommendation] || ':question:';
  const attEmoji = ATTENDANCE_EMOJI[analysis.chef_attendance_assessment] || ':question:';

  const claimsLines = (analysis.claim_analysis || [])
    .map((c) => {
      const emoji = CLAIM_EMOJI[c.status] || ':grey_question:';
      return `${emoji} "${c.claim}" \u2014 ${c.evidence}`;
    })
    .join('\n');

  const rebuttalLines = (analysis.suggested_rebuttal_points || [])
    .map((r, i) => `${i + 1}. ${r}`)
    .join('\n');

  const flagsBlock =
    analysis.flags && analysis.flags.length > 0
      ? `\n:warning: *Flags:*\n${analysis.flags.map((f) => `\u2022 ${f}`).join('\n')}`
      : '';

  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `[DISPUTE] $${amount} \u2014 ${dispute.network_reason_code || dispute.reason} \u2014 ${booking.first_name} ${booking.last_name}`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `*Recommendation:* ${recEmoji} ${analysis.recommendation}`,
          `*Evidence strength:* ${analysis.evidence_strength}`,
          `*Dispute ID:* ${analysis.dispute_id}`,
          `*Booking ID:* ${analysis.booking_id}`,
        ].join('\n'),
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Deadline:*\n${formatDeadline(analysis)}`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Chef attendance:* ${attEmoji} ${analysis.chef_attendance_assessment}`,
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Claim analysis:*\n${claimsLines || 'No claims analysed'}`,
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Rebuttal points:*\n${rebuttalLines || 'None'}`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Reasoning:*\n${analysis.reasoning || 'N/A'}${flagsBlock}`,
      },
    },
    { type: 'divider' },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Approve & Generate Evidence' },
          style: 'primary',
          action_id: 'approve_dispute',
          value: dispute.id,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Escalate for Review' },
          action_id: 'escalate_dispute',
          value: dispute.id,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Dismiss' },
          style: 'danger',
          action_id: 'dismiss_dispute',
          value: dispute.id,
        },
      ],
    },
  ];

  return { blocks };
}
