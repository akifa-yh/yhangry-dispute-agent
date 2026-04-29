import dotenv from 'dotenv';
dotenv.config({ override: true });
import express from 'express';
import pkg from '@slack/bolt';
const { App, ExpressReceiver } = pkg;
import { stripe as getStripe } from './integrations/stripe.js';
import { submitEvidence } from './integrations/stripe.js';
import { investigateDispute, analyseDispute } from './agent/index.js';
import {
  getDisputeState,
  updateMessage,
  postFollowUp,
  postError as postSlackError,
  openNarrativeModal,
  updateDisputeReview,
  updateDisputeReviewByCoords,
  decodeModalMetadata,
} from './integrations/slack.js';
import { decodeButtonValue } from './agent/decision.js';
import { generateEvidence } from './evidence/generator.js';

const PORT = process.env.PORT || 3000;

// Post unhandled investigation errors to Slack so they never die silently in
// the Render logs. Wrapped in its own try/catch so a Slack-side failure
// doesn't escalate into an unhandled rejection.
async function reportInvestigationError(source, dispute, err) {
  console.error(`[${source}] Error investigating dispute ${dispute?.id}:`, err);
  try {
    const amount = typeof dispute?.amount === 'number'
      ? `$${(dispute.amount / 100).toFixed(2)}`
      : 'unknown';
    const reason = dispute?.network_reason_code || dispute?.reason || 'unknown';
    const trimmedMsg = (err?.message || String(err)).slice(0, 800);
    await postSlackError(
      `Investigation failed before posting recommendation`,
      {
        source,
        dispute_id: dispute?.id || 'unknown',
        amount,
        reason,
        error: trimmedMsg,
      }
    );
  } catch (slackErr) {
    console.error(`[${source}] Also failed to post error to Slack:`, slackErr?.message || slackErr);
  }
}

// --- Slack Bolt with Express ---
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: '/slack/events', // Slack events endpoint
  processBeforeResponse: true,
});

const slackApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

// --- Slack button handlers ---

// Helper to extract the dispute and the original message coordinates from
// any action-button click. Both come from the Slack body so we never need
// the in-memory state to recover them.
function actionContext(action, body) {
  const dispute = decodeButtonValue(action.value);
  const messageTs = body.message?.ts || body.container?.message_ts;
  // For ephemeral fallbacks we also stash the channel id (Slack provides
  // it under different paths depending on the action surface).
  const channelId = body.channel?.id || body.container?.channel_id || process.env.SLACK_CHANNEL_ID;
  return { dispute, messageTs, channelId };
}

slackApp.action('approve_dispute', async ({ action, ack, body }) => {
  await ack();
  const { dispute, messageTs } = actionContext(action, body);
  if (!dispute?.id) {
    console.error('[server] approve_dispute: bad button payload', action.value);
    return;
  }

  // Try in-memory state first; if missing (Render idle-sleep wiped it),
  // re-run the investigation from scratch so we have analysis + booking +
  // messages + contacts to feed into evidence generation.
  let state = getDisputeState(dispute.id);
  if (!state) {
    console.log(`[server] approve_dispute: state miss for ${dispute.id}, re-analysing from button payload`);
    try {
      const result = await analyseDispute(dispute);
      if (!result.booking) throw new Error(`Booking lookup failed for ${dispute.payment_intent}`);
      state = {
        message_ts: messageTs,
        dispute,
        analysis: result.analysis,
        booking: result.booking,
        all_contacts: result.allContacts,
        messages: result.messages,
        narrative: null,
      };
    } catch (err) {
      console.error(`[server] approve_dispute recovery failed for ${dispute.id}:`, err);
      if (messageTs) await postFollowUp(messageTs, `:x: Couldn't re-analyse dispute on approve: ${err.message}`);
      return;
    }
  }

  try {
    const docxBuffer = await generateEvidence({
      analysis: state.analysis,
      dispute,
      booking: state.booking,
      platformMessages: state.messages || [],
      allContacts: state.all_contacts || [],
    });

    await submitEvidence(dispute.id, state.analysis, state.booking, docxBuffer);

    const ts = new Date().toISOString();
    await updateMessage(messageTs || state.message_ts, `✅ Evidence submitted to Stripe at ${ts}`);
  } catch (err) {
    console.error(`[server] Error approving dispute ${dispute.id}:`, err);
    if (messageTs || state.message_ts) {
      await postFollowUp(messageTs || state.message_ts, `:x: Error submitting evidence: ${err.message}`);
    }
  }
});

slackApp.action('escalate_dispute', async ({ action, ack, body }) => {
  await ack();
  const { dispute, messageTs } = actionContext(action, body);
  if (!dispute?.id || !messageTs) return;

  const ts = new Date().toISOString();
  await updateMessage(messageTs, `🔴 Escalated for manual review at ${ts}`);
  await postFollowUp(
    messageTs,
    `<!here> This dispute needs manual review — ${dispute.id}`
  );
});

slackApp.action('dismiss_dispute', async ({ action, ack, body }) => {
  await ack();
  const { dispute, messageTs } = actionContext(action, body);
  if (!dispute?.id || !messageTs) return;

  const ts = new Date().toISOString();
  await updateMessage(messageTs, `Dismissed at ${ts}`);
  console.log(`[server] Dispute ${dispute.id} dismissed`);
});

// --- Customer narrative flow ---
//
// 1. User clicks "Add Customer Narrative" on a dispute review message
// 2. We open a modal with a multiline textarea
// 3. User pastes the VROL questionnaire text and submits
// 4. We re-run analyseDispute() with the narrative threaded through
// 5. We update the original Slack message in place with the new analysis,
//    which now includes customer_claims, claim_analysis (per-claim mapping),
//    and unaddressed_claims sections.

slackApp.action('add_narrative', async ({ action, ack, body, client }) => {
  await ack();

  // Decode the dispute payload from the button's value field. This makes the
  // handler resilient to in-memory state loss (Render free-tier idle-sleep
  // wipes state every ~50s of inactivity).
  const dispute = decodeButtonValue(action.value);
  if (!dispute?.id) {
    console.error('[server] add_narrative: failed to decode button value', action.value);
    return;
  }

  // Best-effort: pull the customer name from in-memory state if it still
  // exists, so the modal copy can personalise. If state is gone, fall back
  // to a generic prompt.
  const state = getDisputeState(dispute.id);
  const customerName =
    state?.booking?.first_name && state?.booking?.last_name
      ? `${state.booking.first_name} ${state.booking.last_name}`
      : null;

  try {
    await openNarrativeModal({
      triggerId: body.trigger_id,
      dispute,
      channelId: body.channel?.id || body.container?.channel_id || process.env.SLACK_CHANNEL_ID,
      messageTs: body.message?.ts || body.container?.message_ts,
      customerName,
    });
  } catch (err) {
    console.error(`[server] Failed to open narrative modal for ${dispute.id}:`, err);
  }
});

slackApp.view('add_narrative_submitted', async ({ ack, body, view }) => {
  // Acknowledge the modal submission immediately so Slack closes it.
  await ack();

  // The dispute payload + message coordinates were encoded into private_metadata
  // when the modal was opened. We use these directly instead of relying on
  // in-memory state (which Render's idle-sleep can wipe).
  const meta = decodeModalMetadata(view.private_metadata);
  if (!meta?.dispute?.id) {
    console.error('[server] view submission: failed to decode private_metadata', view.private_metadata);
    return;
  }

  const { dispute, channelId, messageTs } = meta;
  const narrative = view.state.values?.narrative_block?.narrative_input?.value || '';

  console.log(
    `[server] Narrative submitted for ${dispute.id} (${narrative.length} chars) by user ${body.user?.id}`
  );

  if (!narrative.trim()) {
    console.warn(`[server] Empty narrative submitted for ${dispute.id} — skipping re-analysis`);
    return;
  }

  // Re-run the analysis with the narrative attached. Same code path as the
  // initial investigation — analyseDispute will pull fresh booking data,
  // contacts and platform messages, and Gemini will now produce
  // customer_claims, claim_analysis and unaddressed_claims.
  try {
    const result = await analyseDispute(dispute, { narrative });
    if (!result.booking) {
      throw new Error(
        `Booking lookup failed during re-analysis for payment_id: ${dispute.payment_intent}`
      );
    }

    await updateDisputeReviewByCoords({
      channelId,
      messageTs,
      analysis: result.analysis,
      dispute,
      booking: result.booking,
      allContacts: result.allContacts,
      messages: result.messages,
      narrative,
    });

    console.log(
      `[server] Re-analysed and updated ${dispute.id} with narrative (${result.analysis.customer_claims?.length || 0} claims extracted)`
    );
  } catch (err) {
    console.error(`[server] Narrative re-analysis failed for ${dispute.id}:`, err);
    try {
      await postSlackError(
        `Re-analysis with customer narrative failed`,
        {
          dispute_id: dispute.id,
          error: (err?.message || String(err)).slice(0, 800),
        }
      );
    } catch {}
  }
});

// --- Stripe webhook ---

const app = receiver.app;

// Stripe needs raw body for signature verification
app.post(
  '/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    const sig = req.headers['stripe-signature'];

    // Try both UK and US webhook secrets
    const secrets = [
      process.env.STRIPE_WEBHOOK_SECRET_UK,
      process.env.STRIPE_WEBHOOK_SECRET_US,
    ].filter(Boolean);

    let event;
    let verified = false;
    for (const secret of secrets) {
      try {
        event = getStripe().webhooks.constructEvent(req.body, sig, secret);
        verified = true;
        break;
      } catch (err) {
        // Try next secret
      }
    }

    if (!verified) {
      console.error('[stripe] Webhook signature verification failed for all secrets');
      return res.status(400).send('Webhook Error: signature verification failed');
    }

    // Respond 200 immediately
    res.status(200).json({ received: true });

    // Only process dispute.created events
    if (event.type !== 'charge.dispute.created') {
      return;
    }

    const dispute = event.data.object;
    console.log(`[stripe] Received dispute: ${dispute.id}`);

    // Process asynchronously. Errors are surfaced to Slack via the helper.
    investigateDispute(dispute).catch((err) => reportInvestigationError('webhook', dispute, err));
  }
);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Test endpoint — triggers investigation with a known booking
// Usage: curl -X POST http://localhost:3000/test/dispute
app.post('/test/dispute', express.json(), async (req, res) => {
  const testDispute = {
    id: req.body?.id || 'dp_test_button_test',
    amount: req.body?.amount || 50000,
    reason: req.body?.reason || 'product_unacceptable',
    network_reason_code: req.body?.network_reason_code || '13.3',
    payment_intent: req.body?.payment_intent || 'pi_3SzM7lJslp99M2l00goxYOFB',
    charge: req.body?.charge || 'ch_test',
  };
  res.json({ status: 'investigating', dispute_id: testDispute.id });
  investigateDispute(testDispute).catch((err) => reportInvestigationError('test', testDispute, err));
});

// --- Start ---

(async () => {
  await slackApp.start(PORT);
  console.log(`⚡ Dispute agent running on port ${PORT}`);
})();
