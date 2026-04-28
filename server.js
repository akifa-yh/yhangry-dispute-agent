import dotenv from 'dotenv';
dotenv.config({ override: true });
import express from 'express';
import pkg from '@slack/bolt';
const { App, ExpressReceiver } = pkg;
import { stripe as getStripe } from './integrations/stripe.js';
import { submitEvidence } from './integrations/stripe.js';
import { investigateDispute } from './agent/index.js';
import {
  getDisputeState,
  updateMessage,
  postFollowUp,
  postError as postSlackError,
} from './integrations/slack.js';
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

slackApp.action('approve_dispute', async ({ action, ack, say }) => {
  await ack();
  const disputeId = action.value;
  const state = getDisputeState(disputeId);

  if (!state) {
    await say(`Could not find state for dispute ${disputeId}`);
    return;
  }

  try {
    // Generate evidence PDF
    const docxBuffer = await generateEvidence({
      analysis: state.analysis,
      dispute: { id: disputeId, amount: state.analysis.amount || 0, ...state },
      booking: state.booking,
      platformMessages: state.messages || [],
      allContacts: state.all_contacts || [],
    });

    // Submit to Stripe
    await submitEvidence(disputeId, state.analysis, state.booking, docxBuffer);

    // Update Slack message
    const ts = new Date().toISOString();
    await updateMessage(state.message_ts, `✅ Evidence submitted to Stripe at ${ts}`);
  } catch (err) {
    console.error(`[server] Error approving dispute ${disputeId}:`, err);
    await postFollowUp(
      state.message_ts,
      `:x: Error submitting evidence: ${err.message}`
    );
  }
});

slackApp.action('escalate_dispute', async ({ action, ack }) => {
  await ack();
  const disputeId = action.value;
  const state = getDisputeState(disputeId);

  if (!state) return;

  const ts = new Date().toISOString();
  await updateMessage(state.message_ts, `🔴 Escalated for manual review at ${ts}`);
  await postFollowUp(
    state.message_ts,
    `<!here> This dispute needs manual review — ${disputeId}`
  );
});

slackApp.action('dismiss_dispute', async ({ action, ack }) => {
  await ack();
  const disputeId = action.value;
  const state = getDisputeState(disputeId);

  if (!state) return;

  const ts = new Date().toISOString();
  await updateMessage(state.message_ts, `Dismissed at ${ts}`);
  console.log(`[server] Dispute ${disputeId} dismissed`);
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
