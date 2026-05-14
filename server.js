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
  openVrolUploadModal,
  openEvidenceUploadModal,
  uploadEvidencePdf,
  updateDisputeReview,
  updateDisputeReviewByCoords,
  decodeModalMetadata,
} from './integrations/slack.js';
import { parseVrolPdf } from './integrations/vrol_parser.js';
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
//
// processBeforeResponse is INTENTIONALLY false (the default). With true,
// Bolt holds the HTTP response until the handler returns — that's the
// right mode for serverless platforms like Lambda where the function
// shuts down on response, but it's WRONG for our long-running Render
// server. With true, `await ack()` won't actually close the modal until
// the entire handler finishes, so users see the narrative-paste modal
// hang for the full 30-60s of Gemini analysis.
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: '/slack/events', // Slack events endpoint
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

// --- Upload VROL flow (Tyler retro #10) ---
//
// 1. User clicks "Upload VROL" on a dispute review message
// 2. We open a modal with a file_input element accepting a single PDF
// 3. User uploads the Visa Resolve Online questionnaire from the issuer
// 4. We fetch the PDF, parse out the reason code + narrative via
//    integrations/vrol_parser.js, override the dispute's
//    network_reason_code with the VROL value (VROL is authoritative —
//    Stripe webhook reason codes are often inaccurate), and re-run
//    analyseDispute() with the parsed narrative.
// 5. The existing Slack dispute message is updated in place with the
//    refreshed analysis.

slackApp.action('upload_vrol', async ({ action, ack, body }) => {
  await ack();
  const { dispute, messageTs, channelId } = actionContext(action, body);
  if (!dispute?.id) {
    console.error('[server] upload_vrol: bad button payload', action.value);
    return;
  }
  try {
    await openVrolUploadModal({
      triggerId: body.trigger_id,
      dispute,
      channelId,
      messageTs,
    });
  } catch (err) {
    console.error(`[server] Failed to open VROL upload modal for ${dispute.id}:`, err);
  }
});

slackApp.view('upload_vrol_submitted', async ({ ack, body, view }) => {
  await ack();

  const meta = decodeModalMetadata(view.private_metadata);
  if (!meta?.dispute?.id) {
    console.error('[server] vrol submission: failed to decode private_metadata', view.private_metadata);
    return;
  }
  const { dispute, channelId, messageTs } = meta;

  const files = view.state.values?.vrol_block?.vrol_input?.files || [];
  if (files.length === 0) {
    console.warn(`[server] No VROL uploaded for ${dispute.id}`);
    try {
      await postFollowUp(messageTs, ':warning: No VROL was attached. Click *Upload VROL* again to retry.');
    } catch {}
    return;
  }

  const file = files[0];
  console.log(`[server] VROL upload: ${dispute.id} — ${file.name} by user ${body.user?.id}`);

  try {
    // Fetch the PDF from Slack (requires files:read scope on the bot).
    const url = file.url_private_download || file.url_private;
    if (!url) throw new Error('VROL file has no download URL');
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    });
    if (!resp.ok) throw new Error(`Failed to fetch VROL from Slack: HTTP ${resp.status}`);
    const pdfBuffer = Buffer.from(await resp.arrayBuffer());

    // Parse the VROL.
    const parsed = await parseVrolPdf(pdfBuffer);
    console.log(
      `[server] VROL parsed for ${dispute.id}: case=${parsed.caseNumber}, reasonCode=${parsed.reasonCode}, narrative_len=${parsed.narrative?.length}`
    );

    if (!parsed.reasonCode) {
      try {
        await postFollowUp(
          messageTs,
          ':warning: Could not extract a reason code from the VROL PDF. The agent will re-run analysis using the original webhook reason code plus the extracted narrative.'
        );
      } catch {}
    }

    // Override the dispute's reason code with the VROL value (authoritative).
    const overriddenDispute = {
      ...dispute,
      network_reason_code: parsed.reasonCode || dispute.network_reason_code,
    };

    // Re-run analysis with the parsed narrative attached.
    const result = await analyseDispute(overriddenDispute, { narrative: parsed.narrative });
    if (!result.booking) {
      throw new Error(`Booking lookup failed during VROL re-analysis for ${overriddenDispute.payment_intent}`);
    }

    await updateDisputeReviewByCoords({
      channelId,
      messageTs,
      analysis: result.analysis,
      dispute: overriddenDispute,
      booking: result.booking,
      allContacts: result.allContacts,
      messages: result.messages,
      narrative: parsed.narrative,
    });

    const codeBefore = dispute.network_reason_code || '(none)';
    const codeAfter = parsed.reasonCode || codeBefore;
    const codeNote = codeBefore === codeAfter
      ? `Reason code unchanged at \`${codeAfter}\` (VROL agrees with webhook).`
      : `Reason code corrected from \`${codeBefore}\` → \`${codeAfter}\` per VROL.`;

    await postFollowUp(
      messageTs,
      `:white_check_mark: *VROL parsed and re-analysed.* ${codeNote}` +
        (parsed.caseNumber ? `\nVROL case number: \`${parsed.caseNumber}\`` : '') +
        (parsed.comments
          ? `\n_Cardholder comments captured from VROL Comments field._`
          : `\n_VROL Comments field empty — narrative synthesised from structured fields (typical for 12.x processing-error cases)._`)
    );

    console.log(`[server] VROL re-analysis complete for ${dispute.id}`);
  } catch (err) {
    console.error(`[server] VROL processing failed for ${dispute.id}:`, err);
    try {
      await postFollowUp(messageTs, `:x: VROL processing failed: ${err.message}`);
    } catch {}
  }
});

// --- Upload Evidence flow (Tyler retro #8 sub-commit 3) ---
//
// 1. User clicks "Upload Evidence" on a dispute review message
// 2. We open a modal with a file_input + descriptions textarea
// 3. User selects JPG/PNG screenshots and submits
// 4. We fetch each file from Slack as a Buffer, build an exhibits[] list,
//    re-run analyseDispute() for fresh booking/messages/contacts, and
//    regenerate the merchant response PDF via generateEvidence().
// 5. PDF posts back to the dispute's thread for ops to download + submit
//    to Stripe.

slackApp.action('upload_evidence', async ({ action, ack, body }) => {
  await ack();
  const { dispute, messageTs, channelId } = actionContext(action, body);
  if (!dispute?.id) {
    console.error('[server] upload_evidence: bad button payload', action.value);
    return;
  }
  try {
    await openEvidenceUploadModal({
      triggerId: body.trigger_id,
      dispute,
      channelId,
      messageTs,
    });
  } catch (err) {
    console.error(`[server] Failed to open upload modal for ${dispute.id}:`, err);
  }
});

slackApp.view('upload_evidence_submitted', async ({ ack, body, view }) => {
  await ack();

  const meta = decodeModalMetadata(view.private_metadata);
  if (!meta?.dispute?.id) {
    console.error('[server] upload submission: failed to decode private_metadata', view.private_metadata);
    return;
  }
  const { dispute, channelId, messageTs } = meta;

  // Extract uploaded files. Slack's file_input element returns an array of
  // file objects under view.state.values.<block_id>.<action_id>.files
  const files =
    view.state.values?.files_block?.files_input?.files || [];
  if (files.length === 0) {
    console.warn(`[server] No files uploaded for ${dispute.id}`);
    try {
      await postFollowUp(messageTs, ':warning: No files were attached. Click *Upload Evidence* again to retry.');
    } catch {}
    return;
  }

  // Parse per-file descriptions (one line per file, in upload order).
  const descriptionsText =
    view.state.values?.descriptions_block?.descriptions_input?.value || '';
  const descriptionLines = descriptionsText.split('\n');

  console.log(
    `[server] Evidence upload: ${dispute.id} — ${files.length} file(s) by user ${body.user?.id}`
  );

  try {
    // Re-run analysis for fresh booking/messages/contacts. The in-memory
    // state Map can be stale on Render free tier, so we always re-fetch.
    const result = await analyseDispute(dispute);
    if (!result.booking) {
      throw new Error(`Booking lookup failed for ${dispute.payment_intent}`);
    }

    // Fetch each file as a Buffer via Slack's authenticated download URL.
    // Requires the bot token to have `files:read` scope.
    const exhibits = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const url = f.url_private_download || f.url_private;
      if (!url) {
        console.warn(`[server] File ${i} has no download URL — skipping`);
        continue;
      }
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
      });
      if (!resp.ok) {
        console.warn(`[server] Failed to fetch file ${f.name || i}: HTTP ${resp.status}`);
        continue;
      }
      const buffer = Buffer.from(await resp.arrayBuffer());
      const description = (descriptionLines[i] || '').trim() || f.title || f.name || '';
      exhibits.push({ description, source: buffer });
    }

    if (exhibits.length === 0) {
      throw new Error('All file fetches failed — check bot has files:read scope');
    }

    const customerName = `${result.booking.first_name || ''} ${result.booking.last_name || ''}`.trim() || 'Cardholder';
    const pdfBuffer = await generateEvidence({
      analysis: result.analysis,
      dispute,
      booking: result.booking,
      platformMessages: result.messages,
      allContacts: result.allContacts,
      exhibits,
    });

    await uploadEvidencePdf({
      channelId,
      threadTs: messageTs,
      pdfBuffer,
      filename: `Merchant Response — ${customerName}.pdf`,
      initialComment: `:page_facing_up: *Merchant Response PDF* — ${exhibits.length} exhibit${exhibits.length === 1 ? '' : 's'} embedded. Review before submitting to Stripe.`,
    });

    console.log(`[server] Posted evidence PDF for ${dispute.id} with ${exhibits.length} exhibit(s)`);
  } catch (err) {
    console.error(`[server] Evidence upload generation failed for ${dispute.id}:`, err);
    try {
      await postFollowUp(messageTs, `:x: Failed to generate evidence PDF: ${err.message}`);
    } catch {}
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

// Webhook idempotency. Stripe occasionally redelivers events: cold-start
// timeouts on Render free-tier are the common cause (gateway buffers the
// request during ~20s wake-up, Stripe times out at 30s and retries, both
// deliveries succeed against the now-warm server). Without dedup we run
// the full investigation twice and post two Slack messages — exactly what
// happened 2026-05-02 17:11 IST for du_1TSbuXJslp99M2l08y417Rqk. Stripe
// event IDs are stable across retries, so we keep an in-memory map and
// skip duplicates within a 5-minute window. The map gets wiped on idle-
// sleep, but back-to-back retries hit the same warm process so it works
// for the case we actually see.
const seenStripeEventIds = new Map();
const STRIPE_EVENT_TTL_MS = 5 * 60 * 1000;

function alreadyProcessedStripeEvent(eventId) {
  const now = Date.now();
  for (const [id, t] of seenStripeEventIds) {
    if (now - t > STRIPE_EVENT_TTL_MS) seenStripeEventIds.delete(id);
  }
  if (seenStripeEventIds.has(eventId)) return true;
  seenStripeEventIds.set(eventId, now);
  return false;
}

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

    // Respond 200 immediately. We always 200 a duplicate too — otherwise
    // Stripe keeps retrying.
    res.status(200).json({ received: true });

    // Only process dispute.created events
    if (event.type !== 'charge.dispute.created') {
      return;
    }

    // Idempotency: skip if we've already processed this Stripe event id
    // within the TTL window. Catches retries from cold-start timeouts.
    if (alreadyProcessedStripeEvent(event.id)) {
      console.log(`[stripe] Skipping duplicate event ${event.id} (dispute ${event.data.object.id})`);
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
