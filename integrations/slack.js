import { WebClient } from '@slack/web-api';
import { formatSlackMessage } from '../agent/decision.js';
import { formatMoney } from '../utils/money.js';

// Lazy init — env vars may not be loaded when this module is first imported
let _web;
function web() {
  if (!_web) _web = new WebClient(process.env.SLACK_BOT_TOKEN);
  return _web;
}
const channelId = () => process.env.SLACK_CHANNEL_ID;

// In-memory state store (v1)
// TODO v1.5: Replace with BigQuery dispute_agent_state table for persistence
// across Render redeploys. Right now state is wiped on restart, which means
// "Add Customer Narrative" on a stale message will fail until we re-trigger.
const disputeState = new Map();

export function getDisputeState(disputeId) {
  return disputeState.get(disputeId);
}

/**
 * Post a fresh dispute review message to #stripe-disputes and store the
 * state needed for follow-up actions (button clicks, narrative re-analysis).
 */
export async function postDisputeReview(analysis, dispute, booking, allContacts, messages) {
  const { blocks } = formatSlackMessage(analysis, dispute, booking);

  const result = await web().chat.postMessage({
    channel: channelId(),
    blocks,
    text: `[DISPUTE] ${formatMoney(dispute.amount, dispute.currency)} — ${booking.first_name} ${booking.last_name}`,
  });

  // Store everything needed to re-analyse on narrative paste, generate
  // evidence on approve, etc. We deliberately keep the full dispute object
  // here — without it we can't re-call analyseDispute() because we'd be
  // missing payment_intent, amount, reason etc.
  disputeState.set(dispute.id, {
    message_ts: result.ts,
    channel_id: result.channel,
    dispute_id: dispute.id,
    dispute,
    analysis,
    booking,
    all_contacts: allContacts,
    messages,
    narrative: null,
    posted_at: new Date().toISOString(),
    last_updated_at: null,
  });

  console.log(`[slack] Posted dispute review for ${dispute.id} (ts: ${result.ts})`);

  // Persist the message coordinates to the Stripe dispute's metadata so the
  // later charge.dispute.closed webhook can locate this exact thread to
  // post the outcome under. In-memory state (disputeState above) doesn't
  // survive Render idle-sleep or the weeks/months between created and
  // closed; metadata is durable. Non-fatal — if the update fails, the
  // outcome path falls back to Slack search.
  try {
    await persistSlackCoordsToStripeMetadata({
      disputeId: dispute.id,
      messageTs: result.ts,
      channelId: result.channel,
    });
  } catch (err) {
    console.warn(
      `[slack] Could not persist Slack coords to Stripe metadata for ${dispute.id} (non-fatal): ${err.message}`
    );
  }
}

/**
 * Write { slack_message_ts, slack_channel_id } onto a Stripe dispute's
 * metadata. Used at dispute-created time so the dispute-closed handler
 * weeks later can reliably find the original Slack thread to post the
 * outcome under. Routes to the correct Stripe account.
 *
 * Internal helper — kept inside slack.js to keep the storage decision
 * encapsulated. Other code paths shouldn't need to know we're using
 * Stripe metadata as our durable map.
 */
async function persistSlackCoordsToStripeMetadata({ disputeId, messageTs, channelId: chanId }) {
  // Dynamic import to avoid a circular load (slack.js ↔ stripe.js).
  const { fetchDisputeFromEitherAccount, stripe: getStripeUk, getStripeUs } = await import(
    './stripe.js'
  );
  const { account } = await fetchDisputeFromEitherAccount(disputeId);
  const client = account === 'us' ? getStripeUs() : getStripeUk();
  await client.disputes.update(disputeId, {
    metadata: {
      slack_message_ts: String(messageTs || ''),
      slack_channel_id: String(chanId || ''),
    },
  });
  console.log(
    `[slack] Persisted Slack coords to Stripe ${account.toUpperCase()} metadata for ${disputeId} (ts=${messageTs}, channel=${chanId})`
  );
}

/**
 * Update the existing dispute review message in place after a re-analysis
 * (e.g. customer narrative paste). Replaces the blocks; updates state with
 * the fresh analysis + narrative + last_updated_at.
 */
export async function updateDisputeReview({
  disputeId,
  analysis,
  dispute,
  booking,
  allContacts,
  messages,
  narrative,
}) {
  const state = disputeState.get(disputeId);
  if (!state) {
    throw new Error(`Cannot update dispute review: no state found for ${disputeId}`);
  }

  const { blocks } = formatSlackMessage(analysis, dispute, booking, {
    updatedWithNarrativeAt: new Date().toISOString(),
  });

  await web().chat.update({
    channel: state.channel_id,
    ts: state.message_ts,
    blocks,
    text: `[DISPUTE] ${formatMoney(dispute.amount, dispute.currency)} — ${booking.first_name} ${booking.last_name} (updated)`,
  });

  // Refresh state so subsequent button clicks act on the latest analysis
  disputeState.set(disputeId, {
    ...state,
    analysis,
    booking,
    all_contacts: allContacts,
    messages,
    narrative,
    last_updated_at: new Date().toISOString(),
  });

  console.log(`[slack] Updated dispute review for ${disputeId} after narrative paste`);
}

/**
 * Open the "Add Customer Narrative" modal. Triggered by the button on the
 * dispute review message.
 *
 * The full dispute payload + the message location are encoded into the
 * modal's private_metadata as compact JSON. This means the view_submission
 * handler can re-analyse and update the message WITHOUT needing the
 * in-memory disputeState Map — which is wiped whenever Render's free-tier
 * instance idle-sleeps (every ~50s of inactivity).
 *
 * @param {object} args
 * @param {string} args.triggerId
 * @param {object} args.dispute - {id, payment_intent, amount, reason, network_reason_code}
 * @param {string} args.channelId
 * @param {string} args.messageTs
 * @param {string} [args.customerName] - optional, for the modal copy
 */
export async function openNarrativeModal({ triggerId, dispute, channelId, messageTs, customerName }) {
  const meta = JSON.stringify({
    d: {
      id: dispute.id,
      pi: dispute.payment_intent,
      amt: dispute.amount,
      r: dispute.reason,
      nrc: dispute.network_reason_code,
    },
    c: channelId,
    t: messageTs,
  });

  await web().views.open({
    trigger_id: triggerId,
    view: {
      type: 'modal',
      callback_id: 'add_narrative_submitted',
      private_metadata: meta,
      title: { type: 'plain_text', text: 'Paste narrative' },
      submit: { type: 'plain_text', text: 'Re-analyse' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `Paste any customer-side narrative for${customerName ? ` *${customerName}*` : ' this dispute'} — email correspondence, support ticket transcript, or the free-text VROL questionnaire fields if you don't have the PDF.\n\n*If you have the VROL PDF, use* :page_facing_up: *Upload VROL instead* — it extracts the narrative AND overrides the reason code in one step.\n\nThe agent will extract specific factual claims, map our evidence to each (CONTRADICTED / SUPPORTED / UNVERIFIABLE), and flag allegations we can't address with available data.`,
          },
        },
        { type: 'divider' },
        {
          type: 'input',
          block_id: 'narrative_block',
          label: { type: 'plain_text', text: "Customer narrative" },
          element: {
            type: 'plain_text_input',
            action_id: 'narrative_input',
            multiline: true,
            max_length: 3000,
            placeholder: {
              type: 'plain_text',
              text: 'Paste here…',
            },
          },
        },
      ],
    },
  });
}

/**
 * Open the "Upload Evidence" modal. Triggered by the new button on the
 * dispute review message (Tyler retro #8, sub-commit 3).
 *
 * Modal contains:
 *   - file_input element (JPG/PNG/PDF, max 10 files)
 *   - multiline plain_text_input for per-file descriptions (one per line,
 *     in upload order; blank lines fall back to the filename)
 *
 * Private metadata encodes dispute + channel + message_ts so the
 * submission handler can fetch the files, regenerate the PDF with the
 * uploaded exhibits, and post it back to the original message thread —
 * surviving Render idle-sleep without needing the in-memory state Map.
 *
 * @param {object} args
 * @param {string} args.triggerId
 * @param {object} args.dispute  - {id, payment_intent, amount, reason, network_reason_code}
 * @param {string} args.channelId
 * @param {string} args.messageTs
 */
export async function openEvidenceUploadModal({ triggerId, dispute, channelId, messageTs, cachedNarrative }) {
  const meta = JSON.stringify({
    d: {
      id: dispute.id,
      pi: dispute.payment_intent,
      amt: dispute.amount,
      r: dispute.reason,
      nrc: dispute.network_reason_code,
    },
    c: channelId,
    t: messageTs,
  });

  // Pre-fill the in-modal narrative field from the cached narrative (if
  // any) so the operator doesn't have to re-paste it. This is the
  // resilient path: if Render's idle-sleep wiped disputeState between the
  // Update Narrative click and this Upload Evidence click, cachedNarrative
  // will be empty and the operator can paste fresh.
  const initialNarrative = (cachedNarrative || '').slice(0, 3000);

  await web().views.open({
    trigger_id: triggerId,
    view: {
      type: 'modal',
      callback_id: 'upload_evidence_submitted',
      private_metadata: meta,
      title: { type: 'plain_text', text: 'Upload evidence' },
      submit: { type: 'plain_text', text: 'Generate Evidence' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: 'Upload screenshots (JPG/PNG) of supporting evidence — emails, receipts, dashboard views, etc. Each becomes a dedicated page in the merchant response PDF.\n\n*Leave the descriptions field blank* and the agent will use Gemini Vision to identify each image and write the *Document* and *Proves* lines for you, framed against the current rebuttal strategy. Fill it in only if you want to override the auto-descriptions.',
          },
        },
        { type: 'divider' },
        {
          type: 'input',
          block_id: 'files_block',
          label: { type: 'plain_text', text: 'Evidence files' },
          element: {
            type: 'file_input',
            action_id: 'files_input',
            filetypes: ['jpg', 'jpeg', 'png'],
            max_files: 10,
          },
        },
        {
          type: 'input',
          block_id: 'descriptions_block',
          optional: true,
          label: { type: 'plain_text', text: 'Descriptions (optional — blank = auto)' },
          hint: {
            type: 'plain_text',
            text: 'Leave blank to let the agent auto-describe each file via Gemini Vision. To override: one line per file in upload order, format "Document — what it proves". Blank lines within mean auto-describe that file.',
          },
          element: {
            type: 'plain_text_input',
            action_id: 'descriptions_input',
            multiline: true,
            max_length: 2000,
            placeholder: {
              type: 'plain_text',
              // Slack's plain_text_input placeholder caps at 150 chars — keep short.
              text: 'Leave blank to auto-describe via Gemini Vision',
            },
          },
        },
        {
          type: 'input',
          block_id: 'upload_narrative_block',
          optional: true,
          label: { type: 'plain_text', text: 'Customer narrative (optional — pre-filled if pasted earlier)' },
          hint: {
            type: 'plain_text',
            text: 'Same field as Paste Narrative / Upload VROL — controls the rebuttal framing (admission detection, claim parsing). Pre-filled here if you pasted it earlier in this session. Leave as-is to reuse, edit to refine, or blank for a cold analysis.',
          },
          element: {
            type: 'plain_text_input',
            action_id: 'upload_narrative_input',
            multiline: true,
            max_length: 3000,
            ...(initialNarrative ? { initial_value: initialNarrative } : {}),
            placeholder: {
              type: 'plain_text',
              text: 'Paste customer narrative here, or leave blank',
            },
          },
        },
      ],
    },
  });
}

/**
 * Open the "Upload VROL" modal. Tyler retro #10.
 *
 * The Visa Resolve Online (VROL) PDF is the issuing bank's structured
 * dispute form. It's the authoritative source for the network reason
 * code (Stripe's webhook field is sometimes unreliable). Submission handler
 * parses the PDF, overrides the dispute's reason code, builds a narrative
 * from the structured fields (or uses the Comments field if populated),
 * and re-runs analyseDispute().
 */
export async function openVrolUploadModal({ triggerId, dispute, channelId, messageTs }) {
  const meta = JSON.stringify({
    d: {
      id: dispute.id,
      pi: dispute.payment_intent,
      amt: dispute.amount,
      r: dispute.reason,
      nrc: dispute.network_reason_code,
    },
    c: channelId,
    t: messageTs,
  });

  await web().views.open({
    trigger_id: triggerId,
    view: {
      type: 'modal',
      callback_id: 'upload_vrol_submitted',
      private_metadata: meta,
      title: { type: 'plain_text', text: 'Upload VROL' },
      submit: { type: 'plain_text', text: 'Parse & Re-analyse' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: 'Upload the *Visa Resolve Online (VROL) PDF* from the issuing bank. The agent will extract the network reason code + customer narrative, override the (often inaccurate) Stripe webhook reason code with the VROL value, and re-run the dispute analysis.',
          },
        },
        { type: 'divider' },
        {
          type: 'input',
          block_id: 'vrol_block',
          label: { type: 'plain_text', text: 'VROL PDF' },
          element: {
            type: 'file_input',
            action_id: 'vrol_input',
            filetypes: ['pdf'],
            max_files: 1,
          },
        },
      ],
    },
  });
}

/**
 * Upload a PDF buffer as a file in the dispute's Slack thread. Used by the
 * evidence-upload submission handler to deliver the regenerated merchant
 * response PDF (Tyler retro #8, sub-commit 3).
 */
export async function uploadEvidencePdf({ channelId, threadTs, pdfBuffer, filename, initialComment }) {
  await web().filesUploadV2({
    channel_id: channelId,
    thread_ts: threadTs,
    file: pdfBuffer,
    filename,
    initial_comment: initialComment || ':page_facing_up: Merchant Response PDF — review before submitting to Stripe.',
  });
}

/**
 * Find the most recent PDF posted in a dispute's Slack thread and return it
 * as a Buffer. Used by the Approve & Generate Evidence handler to reuse the
 * Upload Evidence-built PDF (with exhibits) instead of regenerating a
 * stripped-down version. Returns null if no PDF is found.
 *
 * Requires the bot to have `files:read` scope (already granted for the
 * Upload Evidence + VROL flows).
 *
 * @param {object} args
 * @param {string} args.channelId
 * @param {string} args.threadTs  - parent message ts of the dispute review
 * @returns {Promise<{buffer: Buffer, filename: string, file_id: string, posted_at: number}|null>}
 */
export async function fetchLatestEvidencePdfFromThread({ channelId, threadTs }) {
  if (!channelId || !threadTs) return null;

  let messages;
  try {
    const res = await web().conversations.replies({
      channel: channelId,
      ts: threadTs,
      limit: 100,
    });
    messages = res.messages || [];
  } catch (err) {
    console.warn(`[slack] conversations.replies failed for ${channelId}/${threadTs}: ${err.message}`);
    return null;
  }

  // Walk newest → oldest to find the most recent BOT-BUILT evidence PDF.
  // Slack returns thread replies in chronological order (oldest first), so
  // we iterate from the end. Only PDFs whose filename matches the
  // uploadEvidencePdf pattern ("Merchant Response — <name>.pdf") qualify:
  // ops drop all sorts of reference PDFs into dispute threads (the
  // customer's VROL questionnaire, bank letters, invoices), and accepting
  // any thread PDF meant Approve could submit the cardholder's own dispute
  // paperwork to Stripe as our evidence (GAN review 2026-07-02).
  let chosen = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const files = m.files || [];
    for (const f of files) {
      const ext = (f.filetype || '').toLowerCase();
      const name = f.name || f.title || '';
      const isPdf = ext === 'pdf' || name.toLowerCase().endsWith('.pdf');
      const isMerchantResponse = /^merchant response/i.test(name.trim());
      if (isPdf && isMerchantResponse) {
        chosen = { file: f, posted_at: Number(m.ts) || 0 };
        break;
      }
      if (isPdf && !isMerchantResponse) {
        console.log(`[slack] Skipping non-evidence PDF in thread: "${name}" (not a Merchant Response file)`);
      }
    }
    if (chosen) break;
  }

  if (!chosen) return null;

  const url = chosen.file.url_private_download || chosen.file.url_private;
  if (!url) {
    console.warn(`[slack] PDF found in thread but no download URL: ${chosen.file.id}`);
    return null;
  }

  let buffer;
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    });
    if (!resp.ok) {
      console.warn(`[slack] Failed to fetch thread PDF ${chosen.file.id}: HTTP ${resp.status}`);
      return null;
    }
    buffer = Buffer.from(await resp.arrayBuffer());
  } catch (err) {
    console.warn(`[slack] Thread PDF fetch threw for ${chosen.file.id}: ${err.message}`);
    return null;
  }

  return {
    buffer,
    filename: chosen.file.name || chosen.file.title || 'evidence.pdf',
    file_id: chosen.file.id,
    posted_at: chosen.posted_at,
  };
}

/**
 * Decode the modal's private_metadata back into a dispute object plus the
 * Slack channel/message coordinates needed to update the original review.
 */
export function decodeModalMetadata(metadata) {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata);
    if (!parsed?.d?.id) return null;
    return {
      dispute: {
        id: parsed.d.id,
        payment_intent: parsed.d.pi,
        amount: parsed.d.amt,
        reason: parsed.d.r,
        network_reason_code: parsed.d.nrc,
      },
      channelId: parsed.c,
      messageTs: parsed.t,
    };
  } catch {
    return null;
  }
}

/**
 * Like updateDisputeReview, but uses explicit channel + ts coordinates
 * instead of looking them up in disputeState. Used by the narrative-paste
 * flow where the in-memory state may have been wiped by Render's idle-sleep.
 */
export async function updateDisputeReviewByCoords({
  channelId,
  messageTs,
  analysis,
  dispute,
  booking,
  allContacts,
  messages,
  narrative,
}) {
  const { blocks } = formatSlackMessage(analysis, dispute, booking, {
    updatedWithNarrativeAt: new Date().toISOString(),
  });

  await web().chat.update({
    channel: channelId,
    ts: messageTs,
    blocks,
    text: `[DISPUTE] ${formatMoney(dispute.amount, dispute.currency)} — ${booking.first_name} ${booking.last_name} (updated)`,
  });

  // Best-effort: if state happens to exist in this process, refresh it so
  // subsequent button clicks served by the same warm instance see the new
  // analysis. If state doesn't exist (cold start), no-op.
  const existing = disputeState.get(dispute.id);
  if (existing) {
    disputeState.set(dispute.id, {
      ...existing,
      analysis,
      booking,
      all_contacts: allContacts,
      messages,
      narrative,
      last_updated_at: new Date().toISOString(),
    });
  }

  console.log(`[slack] Updated dispute review for ${dispute.id} via coords (${channelId}/${messageTs})`);
}

// ============================================================================
// Monthly dispute-ratio report. Benchmarks are reference points only — networks
// revise thresholds (Visa is moving VDMP→VAMP). Data: getDisputeRatioReport()
// in integrations/stripe.js.
// ============================================================================
function ratioStatus(ratio, disputes) {
  if (ratio >= 1.5) {
    return { emoji: ':red_circle:', note: "At/above Mastercard's excessive level (~1.5%) and well past Visa's 0.90% line — monitoring-program risk." };
  }
  if (ratio >= 0.9) {
    return disputes >= 100
      ? { emoji: ':rotating_light:', note: "Above Visa's 0.90% line *and* past the ~100-dispute/mo trigger — real monitoring-program risk. Act." }
      : { emoji: ':rotating_light:', note: `Above Visa's 0.90% line. The low dispute count (${disputes} vs the ~100/mo trigger) is the only thing keeping us out of formal monitoring — that buffer shrinks as volume grows.` };
  }
  if (ratio >= 0.65) {
    return { emoji: ':large_yellow_circle:', note: "In Visa's early-warning band (0.65–0.90%) — watch closely." };
  }
  return { emoji: ':white_check_mark:', note: 'Healthy — below all thresholds.' };
}

function ratioTrend(cur, prior) {
  if (Math.abs(cur - prior) < 0.005) return `▬ flat vs ${prior.toFixed(2)}% last month`;
  return cur > prior ? `▲ up from ${prior.toFixed(2)}% last month` : `▼ down from ${prior.toFixed(2)}% last month`;
}

export async function postDisputeRatioReport(report) {
  const blocks = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `:bar_chart: *Monthly Dispute Ratio — ${report.periodLabel}*\n_Disputes filed ÷ paid charges, per Stripe account._` },
    },
  ];
  for (const a of report.accounts) {
    const st = ratioStatus(a.ratio, a.disputes);
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${a.flag} *${a.name} — ${a.ratio.toFixed(2)}%* ${st.emoji}\n\`${a.disputes} disputes / ${a.paidCharges.toLocaleString('en-US')} paid charges\` · ${ratioTrend(a.ratio, a.priorRatio)}\n_${st.note}_`,
      },
    });
  }
  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text:
        '*:straight_ruler: Benchmarks* _(monthly dispute ratio)_\n' +
        ':white_check_mark: Healthy — under *0.65%*\n' +
        ':large_yellow_circle: Caution / Visa early-warning — *0.65–0.90%*\n' +
        ':large_orange_circle: Visa monitoring (VDMP) — *0.90%+* _and_ 100+ disputes/mo\n' +
        ':red_circle: Mastercard excessive — *~1.5%*\n' +
        ':bulb: Stripe comfort zone — under *0.75%*\n' +
        '_Reference points only; Visa is moving VDMP→VAMP and thresholds change — verify current rules._',
    },
  });
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: ":information_source: A dispute counts the moment it's filed — winning or accepting it doesn't lower this ratio. Only *prevention* (provable delivery, expectation-setting) or *pre-chargeback deflection* (Verifi/Ethoca) brings it down.",
      },
    ],
  });
  await web().chat.postMessage({
    channel: channelId(),
    text: `Monthly Dispute Ratio — ${report.periodLabel}`,
    blocks,
  });
}

// Daily evidence-deadline alert (hit by cron via /reports/deadline-check).
// Posts ONLY when something needs attention: any open dispute due within
// `urgentHours`, or one with no due date at all. Quiet days post nothing —
// an everyday "all fine" message would train ops to ignore the alert.
export async function postDeadlineAlert(openDisputes, urgentHours = 48) {
  const nowSec = Math.floor(Date.now() / 1000);
  const urgent = openDisputes.filter(
    (d) => d.dueBy !== null && d.dueBy - nowSec <= urgentHours * 3600
  );
  const noDate = openDisputes.filter((d) => d.dueBy === null);
  if (!urgent.length && !noDate.length) return false;

  const line = (d) => {
    const hoursLeft = d.dueBy ? Math.max(0, Math.round((d.dueBy - nowSec) / 3600)) : null;
    const when = d.dueBy
      ? `due *${new Date(d.dueBy * 1000).toUTCString()}* (~${hoursLeft}h left)`
      : 'no due date on Stripe — check manually';
    const evidence = d.hasEvidence
      ? d.submissionCount > 0
        ? ':white_check_mark: submitted'
        : ':memo: DRAFT saved, *not submitted*'
      : ':x: no evidence saved';
    return `${d.flag} \`${d.id}\` — ${d.amountDisplay} · ${d.reason} · ${when} · ${evidence}`;
  };

  const sections = [];
  if (urgent.length) {
    sections.push(
      `:rotating_light: *${urgent.length} dispute${urgent.length > 1 ? 's' : ''} due within ${urgentHours}h:*\n` +
        urgent.map(line).join('\n')
    );
  }
  if (noDate.length) {
    sections.push(`:grey_question: *Open with no visible deadline:*\n` + noDate.map(line).join('\n'));
  }
  sections.push(
    `_Anything marked "DRAFT saved, not submitted" loses by default at the deadline — open the dispute in the Stripe dashboard and press *Submit evidence*._`
  );

  await web().chat.postMessage({
    channel: channelId(),
    text: `Dispute evidence deadlines: ${urgent.length} urgent`,
    blocks: sections.map((s) => ({ type: 'section', text: { type: 'mrkdwn', text: s } })),
  });
  return true;
}

export async function postError(text, metadata = {}, nextSteps = null, retryDisputeId = null) {
  const metaStr = Object.entries(metadata)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');

  // Optional "Next steps" block — a plain-English, can't-miss recovery guide so
  // whoever sees the error knows exactly what to do without remembering context.
  const steps = Array.isArray(nextSteps) ? nextSteps : nextSteps ? [nextSteps] : [];
  const stepsStr = steps.length
    ? `\n\n:point_right: *Next steps:*\n` + steps.map((s, i) => `${i + 1}. ${s}`).join('\n')
    : '';

  // Plain-text version is always sent as the notification fallback.
  const fullText = `:x: *Error:* ${text}\n${metaStr ? `_${metaStr}_` : ''}${stepsStr}`;
  const message = { channel: channelId(), text: fullText };

  // When a dispute id is supplied, render with Block Kit so we can attach a
  // one-click "Retry investigation" button (the only self-serve way to re-run a
  // dispute that failed during an outage). The button value is the raw id.
  if (retryDisputeId) {
    message.blocks = [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `:x: *Error:* ${text}${metaStr ? `\n_${metaStr}_` : ''}` },
      },
    ];
    if (stepsStr) {
      message.blocks.push({ type: 'section', text: { type: 'mrkdwn', text: stepsStr.trim() } });
    }
    message.blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '🔄 Retry investigation', emoji: true },
          style: 'primary',
          action_id: 'retry_investigation',
          value: String(retryDisputeId),
        },
      ],
    });
  }

  await web().chat.postMessage(message);
}

export async function updateMessage(ts, text) {
  await web().chat.update({
    channel: channelId(),
    ts,
    text,
    blocks: [],
  });
}

export async function postFollowUp(threadTs, text) {
  await web().chat.postMessage({
    channel: channelId(),
    thread_ts: threadTs,
    text,
  });
}

/**
 * Locate the bot's original dispute-review post coordinates (channel +
 * message ts) so subsequent outcome posts can thread under the same
 * review. Returns null if not found.
 *
 * Resolution order:
 *   1. Stripe dispute metadata (slack_message_ts + slack_channel_id) —
 *      durable, written when the review was originally posted.
 *   2. Slack search by dispute id — fallback for older disputes that
 *      predate the metadata-persistence change.
 *   3. null — caller decides what to do.
 *
 * Search requires `search:read` Slack scope. If it's missing OR search
 * returns nothing, caller should post a clear error (NOT a top-level
 * channel post) so ops can manually thread the outcome.
 */
export async function findDisputeReviewMessageTs(disputeId) {
  // Path 1: Stripe metadata (durable)
  try {
    const { fetchDisputeFromEitherAccount } = await import('./stripe.js');
    const { dispute } = await fetchDisputeFromEitherAccount(disputeId);
    const ts = dispute?.metadata?.slack_message_ts;
    const ch = dispute?.metadata?.slack_channel_id;
    if (ts) {
      return { messageTs: ts, channelId: ch || channelId(), source: 'stripe-metadata' };
    }
  } catch (err) {
    console.warn(
      `[slack] Stripe metadata lookup for thread coords failed for ${disputeId}: ${err.message}`
    );
  }

  // Path 2: Slack search fallback
  try {
    const res = await web().search.messages({
      query: `${disputeId} in:<#${channelId()}>`,
      count: 5,
      sort: 'timestamp',
      sort_dir: 'asc',
    });
    const matches = res?.messages?.matches || [];
    for (const m of matches) {
      if (m.username?.toLowerCase().includes('dispute agent') ||
          m.user === process.env.SLACK_BOT_USER_ID ||
          (m.text || '').includes('[DISPUTE]')) {
        return { messageTs: m.ts, channelId: channelId(), source: 'slack-search' };
      }
    }
    if (matches[0]) {
      return { messageTs: matches[0].ts, channelId: channelId(), source: 'slack-search' };
    }
  } catch (err) {
    console.warn(`[slack] Slack search fallback for ${disputeId} failed: ${err.message}`);
  }

  return null;
}

/**
 * Post a dispute's final outcome (post-resolution) to #stripe-disputes.
 * Threads under the original review when found, falls back to a new
 * top-level message otherwise.
 *
 * The outcome shape is whatever getDisputeFinancialOutcome returns:
 *   { disputeId, formalStatus, netCents, netDisplay, impliedOutcome,
 *     transactions, statusDisagreesWithApi, currency, account }
 */
export async function postDisputeOutcome({ outcome, booking }) {
  const customerName = booking
    ? `${booking.first_name || ''} ${booking.last_name || ''}`.trim() || 'unknown customer'
    : 'unknown customer';
  const formal = (outcome.formalStatus || 'unknown').toUpperCase();
  const formalEmoji =
    outcome.formalStatus === 'won' ? ':white_check_mark:' :
    outcome.formalStatus === 'lost' ? ':red_circle:' :
    outcome.formalStatus === 'warning_closed' ? ':no_entry_sign:' :
    ':information_source:';

  const lines = [
    `${formalEmoji} *Dispute resolved* — \`${outcome.disputeId}\` (${customerName})`,
    `*Formal status:* ${formal}`,
    `*API-derived net to merchant:* ${outcome.netDisplay} (${outcome.impliedOutcome.replace(/_/g, ' ')})`,
  ];

  if (outcome.statusDisagreesWithApi) {
    lines.push('');
    lines.push(
      ':warning: *Heads-up:* Formal status and API balance-transaction net disagree. ' +
        'Stripe may apply account-level adjustments that don\'t surface as per-dispute ' +
        'balance_transactions (this happened on Katie Robertson 2026-05-21). ' +
        '*Verify the actual cash position in Stripe Dashboard → Balance → Payouts* — ' +
        'the dashboard is authoritative when it disagrees with the API view here.'
    );
  }

  if ((outcome.transactions || []).length > 0) {
    lines.push('');
    lines.push('*Balance transactions attached to this dispute:*');
    for (const tx of outcome.transactions) {
      const amt = `${outcome.currency.toUpperCase()} ${(tx.amount_cents / 100).toFixed(2)}`;
      const net = `net ${(tx.net_cents / 100).toFixed(2)}`;
      const fee = tx.fee_cents ? `, fee ${(tx.fee_cents / 100).toFixed(2)}` : '';
      const ts = tx.created_iso || '?';
      const desc = tx.description ? ` — _${tx.description}_` : '';
      lines.push(`• \`${tx.id}\` · ${tx.type} · ${amt} (${net}${fee}) · ${ts}${desc}`);
    }
  } else {
    lines.push('');
    lines.push(
      '_No balance_transactions attached to this dispute yet — Stripe may not ' +
        'have recorded the financial side; check back later or verify in the dashboard._'
    );
  }

  const text = lines.join('\n');
  const coords = await findDisputeReviewMessageTs(outcome.disputeId);

  if (!coords) {
    // No original review thread found anywhere (stripe metadata + slack
    // search both came up empty). Rather than dumping the outcome at the
    // top of #stripe-disputes (which scatters the conversation), post an
    // error so ops can manually thread it under the right post. Aki's
    // 2026-05-22 ask: outcomes ALWAYS belong in the original dispute
    // thread for reference.
    const errorText =
      `:warning: Dispute outcome posted but couldn't find original review thread for \`${outcome.disputeId}\`. ` +
      `Outcome below — please manually thread under the original review:\n\n${text}`;
    await postError(errorText, { dispute_id: outcome.disputeId });
    console.warn(
      `[slack] postDisputeOutcome: no thread coords found for ${outcome.disputeId} — fell back to error post`
    );
    return { posted: true, threadedUnder: null, fallback: 'error-post' };
  }

  await web().chat.postMessage({
    channel: coords.channelId,
    thread_ts: coords.messageTs,
    reply_broadcast: true, // Also show in the channel — outcomes are
                           // important enough that ops shouldn't have to
                           // dig into old threads to see them.
    text,
  });

  console.log(
    `[slack] Posted outcome for ${outcome.disputeId} threaded under ts=${coords.messageTs} (source: ${coords.source}) with broadcast`
  );
  return { posted: true, threadedUnder: coords.messageTs, source: coords.source };
}

// === Product gap alerts ===
// Posts to #product-gaps channel when a tag has appeared in 3+ disputes
// over the past 30 days. Channel id is read from
// SLACK_PRODUCT_GAPS_CHANNEL_ID. The dispute agent bot must be a member of
// the channel (Slack will silently drop posts otherwise).

const productGapsChannelId = () => process.env.SLACK_PRODUCT_GAPS_CHANNEL_ID;

const PRODUCT_GAP_LABELS = {
  missing_click_to_accept_timestamp: 'Missing click-to-accept timestamp',
  no_chef_gps_at_venue: 'No chef GPS at venue',
  no_chef_arrival_photo: 'No chef arrival photo',
  no_signed_substitution_consent: 'No signed substitution consent',
  no_post_event_review_capture: 'No post-event review capture',
  chef_payout_photo_unusable: 'Chef payout photo unusable',
  customer_acknowledgment_not_captured: 'Customer acknowledgment not captured',
};

export async function postProductGapAlert({ tag, occurrenceCount, recentEvents }) {
  const channel = productGapsChannelId();
  if (!channel) {
    console.warn('[slack] SLACK_PRODUCT_GAPS_CHANNEL_ID not set — skipping product gap alert');
    return;
  }
  const label = PRODUCT_GAP_LABELS[tag] || tag;
  const lines = (recentEvents || []).slice(0, 5).map((e) => {
    const dateStr = e.event_date?.value || e.event_date || 'unknown date';
    const code = e.network_reason_code || 'unknown code';
    const booking = e.booking_id != null ? `booking ${e.booking_id}` : 'booking n/a';
    return `• \`${e.dispute_id}\` — ${booking}, event ${dateStr}, ${code}`;
  });
  const text = `:warning: *Product gap:* \`${tag}\` (${label}) — flagged in ${occurrenceCount} disputes over the past 30 days.\n${lines.join('\n')}`;
  await web().chat.postMessage({ channel, text });
  console.log(`[slack] Posted product gap alert for ${tag} (${occurrenceCount} occurrences)`);
}
