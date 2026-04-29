const RECOMMENDATION_EMOJI = {
  STRONG_COUNTER: ':white_check_mark:',
  COUNTER_WITH_CAVEATS: ':warning:',
  ESCALATE: ':red_circle:',
};

const CLAIM_STATUS_EMOJI = {
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

const INDEPENDENCE_EMOJI = {
  HIGH: ':large_green_circle:',
  MEDIUM: ':large_blue_circle:',
  LOW: ':large_yellow_circle:',
};

const SEVERITY_EMOJI = {
  LOW: ':grey_exclamation:',
  MEDIUM: ':warning:',
  HIGH: ':rotating_light:',
};

const CATEGORY_LABEL = {
  timing: ':alarm_clock: timing',
  service_delivery: ':knife_fork_plate: service delivery',
  behavioural: ':speaking_head_in_silhouette: behavioural',
  resolution: ':handshake: resolution',
  other: ':grey_question: other',
};

// Backwards-compat: handle old string-form evidence_to_include entries
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
    return `:clock1: Late — ${absMins} mins after deadline\n${contactInfo}`;
  }

  return `:white_check_mark: Timely — ${absMins} mins before deadline\n${contactInfo}`;
}

/**
 * Render the Slack Block Kit message for a dispute review.
 *
 * @param {object} analysis - structured output from Gemini
 * @param {object} dispute - Stripe dispute object
 * @param {object} booking - BigQuery booking row
 * @param {object} [options]
 * @param {string} [options.updatedWithNarrativeAt] - if set, renders an
 *   "Updated with customer narrative at <ts>" header line above the title
 *   so ops can see at a glance that this analysis was re-run after a paste.
 */
export function formatSlackMessage(analysis, dispute, booking, options = {}) {
  const amount = (dispute.amount / 100).toFixed(2);
  const recEmoji = RECOMMENDATION_EMOJI[analysis.recommendation] || ':question:';
  const attEmoji = ATTENDANCE_EMOJI[analysis.chef_attendance_assessment] || ':question:';

  const narrativeProvided = analysis.narrative_provided === true;
  const customerClaims = analysis.customer_claims || [];
  const claimAnalysis = analysis.claim_analysis || [];
  const unaddressedClaims = analysis.unaddressed_claims || [];

  // Build a claim_id → claim_text map so claim_analysis entries can be
  // rendered with the actual claim text rather than just the id.
  const claimsById = Object.fromEntries(customerClaims.map((c) => [c.id, c]));

  // ---- Customer claims section (only if narrative provided) ----
  const customerClaimsLines = customerClaims
    .map((c, i) => {
      const cat = CATEGORY_LABEL[c.category] || c.category || 'other';
      const num = i + 1;
      return `*${num}.* _${cat}_ — ${c.claim}`;
    })
    .join('\n');

  // ---- Claim analysis (each customer claim mapped to evidence) ----
  const claimAnalysisLines = claimAnalysis
    .map((c) => {
      const emoji = CLAIM_STATUS_EMOJI[c.status] || ':grey_question:';
      const claim = claimsById[c.claim_id];
      const claimText = claim?.claim || c.claim_id || '(unknown claim)';
      const indepTag = c.evidence_independence ? ` _[${c.evidence_independence}]_` : '';
      return `${emoji} *"${claimText}"* — ${c.evidence}${indepTag}`;
    })
    .join('\n');

  // ---- Unaddressed allegations ----
  const unaddressedLines = unaddressedClaims
    .map((u) => {
      const claimText = u.claim || claimsById[u.claim_id]?.claim || u.claim_id;
      return `:warning: *"${claimText}"* — _${u.why_unaddressed}_`;
    })
    .join('\n');

  // ---- Rebuttal points ----
  const rebuttalLines = (analysis.suggested_rebuttal_points || [])
    .map((r, i) => `${i + 1}. ${r}`)
    .join('\n');

  // ---- Evidence to include (with independence scores) ----
  const evidenceItems = (analysis.evidence_to_include || []).map(normaliseEvidence);
  const evidenceLines = evidenceItems
    .map((e) => {
      const emoji = INDEPENDENCE_EMOJI[e.independence_score] || ':grey_question:';
      const scoreTag = e.independence_score ? `[${e.independence_score}]` : '[unscored]';
      const rationale = e.rationale ? ` _— ${e.rationale}_` : '';
      return `${emoji} ${scoreTag} ${e.evidence}${rationale}`;
    })
    .join('\n');

  // ---- Evidence weaknesses & gaps ----
  const weaknesses = analysis.evidence_weaknesses || [];
  const weaknessLines = weaknesses
    .map((w) => {
      const emoji = SEVERITY_EMOJI[w.severity] || ':warning:';
      const sevTag = w.severity ? `[${w.severity}]` : '';
      // affects_claim may be a claim_id; resolve to claim text if possible
      const affectsClaim = claimsById[w.affects_claim]?.claim || w.affects_claim;
      const claimRef = affectsClaim ? ` — affects: _${affectsClaim}_` : '';
      return `${emoji} ${sevTag} ${w.weakness}${claimRef}`;
    })
    .join('\n');

  const flagsBlock =
    analysis.flags && analysis.flags.length > 0
      ? `\n:warning: *Flags:*\n${analysis.flags.map((f) => `• ${f}`).join('\n')}`
      : '';

  // ---- Build blocks ----
  const blocks = [];

  // Optional "updated with narrative" context header (only on re-analysis posts)
  if (options.updatedWithNarrativeAt) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `:memo: _Updated with customer narrative at ${options.updatedWithNarrativeAt}_`,
        },
      ],
    });
  }

  blocks.push({
    type: 'header',
    text: {
      type: 'plain_text',
      text: `[DISPUTE] $${amount} — ${dispute.network_reason_code || dispute.reason} — ${booking.first_name} ${booking.last_name}`,
    },
  });

  blocks.push({
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
  });

  // Pre-narrative banner — visible cue that ops can paste VROL to deepen analysis
  if (!narrativeProvided) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: ':information_source: *Customer narrative not yet provided.* Recommendation below is provisional, based on deadline + chef attendance + platform data only. Click *Add Customer Narrative* and paste the VROL questionnaire to extract the customer\'s specific claims and map our evidence to each.',
      },
    });
  }

  blocks.push({ type: 'divider' });

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*Deadline:*\n${formatDeadline(analysis)}`,
    },
  });

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*Chef attendance:* ${attEmoji} ${analysis.chef_attendance_assessment}`,
    },
  });

  // Customer claims (extracted from narrative) — only when narrative present
  if (narrativeProvided && customerClaims.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Customer claims (${customerClaims.length})* _(extracted from VROL narrative)_:\n${customerClaimsLines}`,
      },
    });
  }

  // Claim analysis — only when there are claims to analyse
  if (claimAnalysis.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Claim analysis* _(evidence mapped to each claim)_:\n${claimAnalysisLines}`,
      },
    });
  }

  // Unaddressed allegations — surface gaps the bank reviewer might exploit
  if (unaddressedClaims.length > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Unaddressed allegations* _(claims we have no evidence on — prepare manually or escalate)_:\n${unaddressedLines}`,
      },
    });
  }

  blocks.push({ type: 'divider' });

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*Rebuttal points:*\n${rebuttalLines || 'None'}`,
    },
  });

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*Evidence to include* _(independence-scored)_:\n${evidenceLines || '_No evidence items listed_'}`,
    },
  });

  if (weaknessLines) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Evidence weaknesses & gaps* _(do NOT submit these as supporting evidence)_:\n${weaknessLines}`,
      },
    });
  }

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*Reasoning:*\n${analysis.reasoning || 'N/A'}${flagsBlock}`,
    },
  });

  blocks.push({ type: 'divider' });

  // Action buttons. We encode the full dispute payload (id, payment_intent,
  // amount, reason, network_reason_code) into each button's `value` field as
  // compact JSON. This lets the action handlers recover the dispute object
  // without needing the in-memory disputeState Map — critical because Render
  // free tier idle-sleeps wipe in-memory state, so any button click made >50s
  // after the message was posted would otherwise fail. Compact key names keep
  // us well inside Slack's 2000-char value limit.
  const buttonPayload = JSON.stringify({
    id: dispute.id,
    pi: dispute.payment_intent || dispute.charge,
    amt: dispute.amount,
    r: dispute.reason,
    nrc: dispute.network_reason_code || null,
  });

  // "Add Customer Narrative" is placed first so it's the most prominent
  // next-step affordance when narrative is missing.
  const narrativeButtonText = narrativeProvided
    ? 'Update Customer Narrative'
    : 'Add Customer Narrative';

  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: narrativeButtonText },
        action_id: 'add_narrative',
        value: buttonPayload,
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Approve & Generate Evidence' },
        style: 'primary',
        action_id: 'approve_dispute',
        value: buttonPayload,
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Escalate for Review' },
        action_id: 'escalate_dispute',
        value: buttonPayload,
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Dismiss' },
        style: 'danger',
        action_id: 'dismiss_dispute',
        value: buttonPayload,
      },
    ],
  });

  return { blocks };
}

/**
 * Decode a button value back into a dispute object. Handles both the new
 * JSON-encoded payload and the legacy raw-dispute-id format (for messages
 * posted before the encoding change).
 */
export function decodeButtonValue(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && parsed.id) {
      return {
        id: parsed.id,
        payment_intent: parsed.pi,
        amount: parsed.amt,
        reason: parsed.r,
        network_reason_code: parsed.nrc,
      };
    }
  } catch {
    // Not JSON — assume legacy format where value was the dispute id directly
  }
  return { id: value, payment_intent: null, amount: null, reason: null, network_reason_code: null };
}
