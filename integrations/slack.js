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
// TODO v1.5: Replace with BigQuery dispute_agent_state table
const disputeState = new Map();

export function getDisputeState(disputeId) {
  return disputeState.get(disputeId);
}

export async function postDisputeReview(analysis, dispute, booking, allContacts, messages) {
  const { blocks } = formatSlackMessage(analysis, dispute, booking);

  const result = await web().chat.postMessage({
    channel: channelId(),
    blocks,
    text: `[DISPUTE] $${(dispute.amount / 100).toFixed(2)} — ${booking.first_name} ${booking.last_name}`,
  });

  // Store state for button handlers
  disputeState.set(dispute.id, {
    message_ts: result.ts,
    dispute_id: dispute.id,
    analysis,
    booking,
    all_contacts: allContacts,
    messages,
  });

  console.log(`[slack] Posted dispute review for ${dispute.id} (ts: ${result.ts})`);
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
