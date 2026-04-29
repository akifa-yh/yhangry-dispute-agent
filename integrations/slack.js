import { WebClient } from '@slack/web-api';
import { formatSlackMessage } from '../agent/decision.js';

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
    text: `[DISPUTE] $${(dispute.amount / 100).toFixed(2)} — ${booking.first_name} ${booking.last_name}`,
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
    text: `[DISPUTE] $${(dispute.amount / 100).toFixed(2)} — ${booking.first_name} ${booking.last_name} (updated)`,
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
      title: { type: 'plain_text', text: 'Customer narrative' },
      submit: { type: 'plain_text', text: 'Re-analyse' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `Paste the customer's account from the VROL questionnaire${customerName ? ` for *${customerName}*` : ''}.\n\nSpecifically the section titled _"Provide details of what was ordered and not as described"_.\n\nThe agent will extract specific factual claims, map our evidence to each (CONTRADICTED / SUPPORTED / UNVERIFIABLE), and flag any allegations we can't address with available data.`,
          },
        },
        { type: 'divider' },
        {
          type: 'input',
          block_id: 'narrative_block',
          label: { type: 'plain_text', text: "Customer's account of events" },
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
    text: `[DISPUTE] $${(dispute.amount / 100).toFixed(2)} — ${booking.first_name} ${booking.last_name} (updated)`,
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

export async function postError(text, metadata = {}) {
  const metaStr = Object.entries(metadata)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');

  await web().chat.postMessage({
    channel: channelId(),
    text: `:x: *Error:* ${text}\n${metaStr ? `_${metaStr}_` : ''}`,
  });
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
