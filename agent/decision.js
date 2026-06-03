const RECOMMENDATION_EMOJI = {
  ACCEPT: ':stop_sign:',
  STRONG_COUNTER: ':white_check_mark:',
  COUNTER_WITH_CAVEATS: ':warning:',
  CUSTOMER_CONTACT_FIRST: ':envelope_with_arrow:',
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
  EVENT_CANCELLED_BY_CUSTOMER: ':no_entry_sign:',
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

const REQ_STATUS_EMOJI = {
  PRESENT: ':white_check_mark:',
  MISSING: ':x:',
};

const CATEGORY_LABEL = {
  timing: ':alarm_clock: timing',
  service_delivery: ':knife_fork_plate: service delivery',
  behavioural: ':speaking_head_in_silhouette: behavioural',
  resolution: ':handshake: resolution',
  other: ':grey_question: other',
};

const PRIORITY_RANK = { PRIMARY: 0, SECONDARY: 1, TERTIARY: 2 };
const INDEPENDENCE_RANK = { HIGH: 0, MEDIUM: 1, LOW: 2 };

// Backwards-compat: handle old string-form evidence_to_include entries
// and entries that don't yet have strategic_priority set.
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

// Sort: PRIMARY first, then by independence within tier (HIGH first).
// Missing priority/independence sort to the end.
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

function formatEventDate(raw) {
  if (!raw) return 'N/A';
  const s = raw?.value || String(raw);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return s;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${m[3]} ${months[parseInt(m[2], 10) - 1]} ${m[1]}`;
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

  // ---- Evidence to include (sorted by strategic priority, then independence) ----
  const evidenceItems = sortEvidenceForRender(
    (analysis.evidence_to_include || []).map(normaliseEvidence)
  );
  const evidenceLines = evidenceItems
    .map((e) => {
      const indepEmoji = INDEPENDENCE_EMOJI[e.independence_score] || ':grey_question:';
      const scoreTag = e.independence_score ? `[${e.independence_score}]` : '[unscored]';
      const priorityTag = e.strategic_priority ? ` _\`${e.strategic_priority}\`_` : '';
      const rationale = e.rationale ? `\n     _${e.rationale}_` : '';
      return `${indepEmoji} ${scoreTag}${priorityTag} ${e.evidence}${rationale}`;
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

  // Optional "re-analysed" context header (only on re-analysis posts).
  // Triggered by both the Paste Narrative flow and the Upload VROL flow.
  if (options.updatedWithNarrativeAt) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `:memo: _Re-analysed with new context at ${options.updatedWithNarrativeAt}_`,
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

  const summaryLines = [
    `*Recommendation:* ${recEmoji} ${analysis.recommendation}`,
    `*Evidence strength:* ${analysis.evidence_strength}`,
  ];
  if (analysis.rebuttal_strategy) {
    summaryLines.push(`*Rebuttal strategy:* ${analysis.rebuttal_strategy.replace(/_/g, ' ')}`);
  }
  summaryLines.push(`*Dispute ID:* ${analysis.dispute_id}`);
  const bookingIdForLink = booking.order_id || analysis.booking_id;
  summaryLines.push(
    `*Booking:* <https://yhangry.com/nova/resources/orders/${bookingIdForLink}|#${bookingIdForLink}>`
  );
  summaryLines.push(`*Event date:* ${formatEventDate(booking.event_date)}`);
  const chefName = [booking.chef_first_name, booking.chef_last_name].filter(Boolean).join(' ').trim();
  if (chefName) summaryLines.push(`*Chef:* ${chefName}`);

  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: summaryLines.join('\n') },
  });

  // ACCEPT banner — when the stolen-card signature flags STRONG_MATCH, the
  // case is unwinnable and we shouldn't be building a counter at all. Make
  // this impossible to miss; it sits above all the rebuttal-shaped content.
  if (analysis.recommendation === 'ACCEPT') {
    const sig = analysis._fraud_signature;
    const overrideNote = analysis._overrode_recommendation
      ? ` _LLM initially recommended ${analysis._overrode_recommendation}; deterministic override applied._`
      : '';
    const signalBits = sig
      ? [
          `issuer ${sig.issuerCountry || 'unknown'} on ${(sig.expectedCountry || 'unknown')} Stripe account`,
          'no billing address',
          `Stripe Radar ${sig.riskLevel || 'unknown'} risk`,
          'fraud reason code',
        ].join(' · ')
      : '';
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:stop_sign: *STOLEN-CARD FRAUD — ACCEPT DISPUTE IN STRIPE.* Click *Accept dispute* in the Stripe dashboard; do NOT counter. The legitimate cardholder did not authorise this charge, so platform-engagement evidence cannot rebut their claim — countering costs the same money and damages our merchant lost-dispute ratio.${signalBits ? `\n_Signals fired: ${signalBits}._` : ''}${overrideNote}`,
      },
    });
  }

  // Customer-admission banner — when Gmail correspondence contains a written
  // admission from the cardholder (per the prompt's CUSTOMER ADMISSION
  // DETECTION rules), it's the strongest possible counter-evidence and the
  // PDF generator already leads with it. Surface it equally prominently in
  // the Slack post so ops sees it at a glance rather than buried in the
  // Reasoning text. Independent of recommendation — admission can co-exist
  // with STRONG_COUNTER, COUNTER_WITH_CAVEATS, etc.
  if (analysis.customer_admission_detected && analysis.customer_admission_evidence) {
    const quote = String(analysis.customer_admission_evidence).trim().replace(/\n+/g, ' ');
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:writing_hand: *CARDHOLDER ADMISSION DETECTED* — the strongest possible counter-evidence. Banks rule for the merchant almost every time when the cardholder has admitted in writing.\n> _"${quote}"_\nThe PDF will lead with this admission as the primary argument.`,
      },
    });
  }

  // Pre-event banner — when the dispute was filed BEFORE the event date,
  // standard rebuttal logic doesn't apply. Make this impossible to miss:
  // it overrides the "approve & generate evidence" instinct. The banner
  // copy varies by rebuttal_strategy: PRE_EVENT_CONTACT (event hasn't
  // happened, intent confusion) vs CUSTOMER_OUTREACH (post-event, but
  // the realistic win path is the cardholder phoning their bank rather
  // than formal evidence — e.g. Visa 12.5 FX gaps, genuine-confusion
  // unrecognized charges).
  if (analysis.recommendation === 'CUSTOMER_CONTACT_FIRST') {
    let bannerText;
    if (analysis.rebuttal_strategy === 'CUSTOMER_OUTREACH') {
      bannerText =
        ':envelope_with_arrow: *CUSTOMER OUTREACH RECOMMENDED — DO NOT SUBMIT EVIDENCE YET.* ' +
        'This looks like a genuine-confusion / non-fraud case where the realistic win ' +
        'path is the cardholder phoning their card issuer to withdraw — formal Visa/MC ' +
        'resolution typically loses on this pattern even with strong evidence. ' +
        '*Email the customer via* `info@yhangry.com` *using the draft below*, then ' +
        'fall back to a formal counter only if no withdrawal confirmation lands by the ' +
        'evidence deadline.';
    } else {
      // Default copy is the existing PRE_EVENT_CONTACT framing
      bannerText =
        ':rotating_light: *PRE-EVENT DISPUTE — DO NOT SUBMIT EVIDENCE YET.* The event ' +
        'has not yet taken place; the customer has likely filed the dispute in error ' +
        '(currency confusion, wanting a booking amendment, etc.). *Email the customer ' +
        'first* via `info@yhangry.com` to clarify intent and request they withdraw the ' +
        'dispute with their issuing bank. Submit a rebuttal only if they refuse and ' +
        'the event date passes.';
    }
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: bannerText },
    });
  }

  // Suggested customer email — copy-paste block for ops. Surfaces whenever
  // the agent has drafted one (CUSTOMER_OUTREACH and PRE_EVENT_CONTACT
  // strategies both populate suggested_customer_email per the prompt).
  // Renders the subject + body in a quoted section so ops can paste it
  // straight into info@yhangry.com without picking around formatting.
  const draftEmail = analysis.suggested_customer_email;
  if (
    draftEmail &&
    typeof draftEmail === 'object' &&
    (draftEmail.subject || draftEmail.body)
  ) {
    const subject = (draftEmail.subject || '').trim();
    const body = (draftEmail.body || '').trim();
    if (body) {
      blocks.push({ type: 'divider' });
      const subjectLine = subject ? `*Subject:* ${subject}\n\n` : '';
      // Render body as a Slack mrkdwn block-quote (each line prefixed with
      // "> ") so it's visually distinct from the surrounding analysis.
      const quotedBody = body
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            `:writing_hand: *Suggested email to customer* — copy-paste from \`info@yhangry.com\`:\n\n` +
            `${subjectLine}${quotedBody}`,
        },
      });
    }
  }

  // Pre-narrative banner — visible cue that ops can paste VROL to deepen analysis.
  // Hidden on ACCEPT because we're not doing claim-level analysis there.
  if (!narrativeProvided && analysis.recommendation !== 'ACCEPT') {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: ':information_source: *Customer narrative not yet provided.* Recommendation below is provisional, based on deadline + chef attendance + platform data only. Use :page_facing_up: *Upload VROL* (preferred — also corrects the reason code) or :pencil2: *Paste Narrative* to add the customer\'s account and unlock claim-level analysis.',
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

  // Skip the rebuttal-shaped sections entirely on ACCEPT — we're not
  // building a counter, so listing rebuttal points / evidence items /
  // evidence requirements would just be visual noise that contradicts the
  // top banner. Also skip the divider that would separate them from the
  // deadline/attendance summary above.
  const buildingCounter = analysis.recommendation !== 'ACCEPT';

  if (buildingCounter) {
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
  }

  // Evidence requirements check — what does this code actually need to win,
  // and what do we have? Only renders when applicable (i.e. we have a
  // playbook entry for this network/reason_code).
  const reqCheck = analysis.evidence_requirements_check;
  if (buildingCounter && reqCheck && reqCheck.applicable) {
    const reqItems = (reqCheck.required || []).map((r) => {
      const emoji = REQ_STATUS_EMOJI[r.status] || ':grey_question:';
      const evidenceTail = r.evidence ? ` — _${r.evidence}_` : '';
      return `${emoji} *${r.type}*${evidenceTail}`;
    }).join('\n');
    const strItems = (reqCheck.strengthening || []).map((r) => {
      const emoji = REQ_STATUS_EMOJI[r.status] || ':grey_question:';
      const evidenceTail = r.evidence ? ` — _${r.evidence}_` : '';
      return `${emoji} ${r.type}${evidenceTail}`;
    }).join('\n');

    const headerSuffix = reqCheck.code_label ? ` _(${reqCheck.code_label})_` : '';
    const missingNote = reqCheck.missing_required_count > 0
      ? `\n:warning: *${reqCheck.missing_required_count} required item${reqCheck.missing_required_count === 1 ? '' : 's'} missing.* Strengthen the case manually before submission, or escalate.`
      : '';
    const summaryNote = reqCheck.summary ? `\n_${reqCheck.summary}_` : '';

    const sections = [];
    if (reqItems) sections.push(`*Required:*\n${reqItems}`);
    if (strItems) sections.push(`*Strengthening:*\n${strItems}`);

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Evidence requirements check*${headerSuffix}:\n${sections.join('\n\n')}${missingNote}${summaryNote}`,
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

  // "Paste Narrative" is the fallback when ops doesn't have the VROL PDF
  // (Upload VROL is the preferred path — see retro #10). Both feed the
  // narrative side of the analysis.
  const narrativeButtonText = narrativeProvided
    ? 'Update Narrative'
    : 'Paste Narrative';

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
        text: { type: 'plain_text', text: 'Upload VROL' },
        action_id: 'upload_vrol',
        value: buttonPayload,
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Upload Evidence' },
        action_id: 'upload_evidence',
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
