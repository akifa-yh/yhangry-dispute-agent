import dotenv from 'dotenv';
dotenv.config({ override: true });
import express from 'express';
import pkg from '@slack/bolt';
const { App, ExpressReceiver } = pkg;
import { stripe as getStripe } from './integrations/stripe.js';
import { submitEvidence, getPaymentAuthForDispute, getDisputeRatioReport, getOpenDisputeDeadlines, getDisputeRecap } from './integrations/stripe.js';
import { postDisputeRatioReport, postDeadlineAlert, postWeeklyDisputeRecap, postMonthlyDisputeRecap } from './integrations/slack.js';
import { investigateDispute, analyseDispute } from './agent/index.js';
import {
  analyseExhibits,
  formatExhibitDescription,
  sortByRelevance,
} from './agent/exhibit_analyser.js';
import {
  getDisputeState,
  updateMessage,
  postFollowUp,
  postError as postSlackError,
  openNarrativeModal,
  openVrolUploadModal,
  openEvidenceUploadModal,
  uploadEvidencePdf,
  fetchLatestEvidencePdfFromThread,
  updateDisputeReview,
  updateDisputeReviewByCoords,
  decodeModalMetadata,
  postInvestigationStarted,
} from './integrations/slack.js';
import { parseVrolPdf } from './integrations/vrol_parser.js';
import { formatMoney } from './utils/money.js';
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
      ? formatMoney(dispute.amount, dispute.currency)
      : 'unknown';
    const reason = dispute?.network_reason_code || dispute?.reason || 'unknown';

    // Always strip HTML and collapse whitespace so a raw error page (e.g. a
    // Google "robot" 403) can never be dumped into Slack as gibberish again.
    const rawMsg = err?.message || String(err);
    const cleanMsg = rawMsg.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

    // Recognise Google's edge anti-abuse block: a valid credential still gets a
    // 403 "robot" HTML page when the server's outbound IP has been flagged.
    // On Render's free tier the outbound IP is shared and rotates per deploy,
    // so the fix is simply to redeploy onto a fresh IP — NOT a credential issue.
    const isGoogleIpBlock =
      /Error 403 \(Forbidden\)|images\/errors\/robot\.png/.test(rawMsg) &&
      /Forbidden/i.test(rawMsg);

    const errorText = isGoogleIpBlock
      ? "Google blocked this server's outbound IP (403 robot page). This is NOT a credentials problem — Render's free tier shares a rotating outbound IP and one got flagged by Google."
      : cleanMsg.slice(0, 800);

    // The "Retry investigation" button re-runs investigateDispute, so only
    // attach it to investigation failures (not webhook-closed outcome posts,
    // where re-investigating a closed dispute would be wrong). Stripe fires
    // charge.dispute.created only once, so this button is the ONLY self-serve
    // way to re-run a dispute that failed during an outage.
    const canRetry = source !== 'webhook-closed' && !!dispute?.id;

    const nextSteps = isGoogleIpBlock
      ? [
          'Open Render → the *yhangry-dispute-agent* service.',
          'Click *Manual Deploy → Deploy latest commit* (top-right).',
          'Wait for it to go green/Live — this rolls the server onto a fresh IP.',
          ...(canRetry
            ? ['Come back here and click the *🔄 Retry investigation* button below. Nothing to change with keys or GCP.']
            : ['Nothing to change with keys or GCP — just the redeploy.']),
        ]
      : [
          ...(canRetry
            ? ['If it looks transient, click the *🔄 Retry investigation* button below.']
            : []),
          "Check this service's logs in Render for the full error.",
          'If it persists, share this message with whoever maintains the agent.',
        ];

    await postSlackError(
      isGoogleIpBlock
        ? 'Investigation failed — Google IP block (redeploy to fix)'
        : `Investigation failed before posting recommendation`,
      {
        source,
        dispute_id: dispute?.id || 'unknown',
        amount,
        reason,
        error: errorText,
      },
      nextSteps,
      canRetry ? dispute.id : null
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

// In-flight guard: approve involves a 30-90s re-analysis on the cold path and
// two Stripe writes; a double-click (or two approvers) raced two full
// submissions and could attach different PDFs (GAN review ops-M2). Ids are
// held only for the duration of the click — in-memory is fine because a
// restart mid-approve kills the in-flight work anyway.
const approvalsInFlight = new Set();

// Optional approver allowlist (GAN review ops-M7): when SLACK_APPROVER_IDS is
// set (comma-separated Slack user ids), only listed users can Approve,
// Dismiss, or Escalate. Unset = everyone in the channel (current behavior) —
// dormant until ops decides who should hold the pen.
async function checkApprover(body, messageTs, actionLabel) {
  const allow = (process.env.SLACK_APPROVER_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!allow.length) return true;
  const userId = body.user?.id;
  if (userId && allow.includes(userId)) return true;
  console.log(`[server] ${actionLabel} blocked for unauthorized user ${userId || 'unknown'}`);
  if (messageTs) {
    await postFollowUp(
      messageTs,
      `:lock: <@${userId}> — *${actionLabel}* is limited to the approver list (SLACK_APPROVER_IDS). Nothing was changed.`
    ).catch(() => {});
  }
  return false;
}

slackApp.action('approve_dispute', async ({ action, ack, body }) => {
  await ack();
  const { dispute, messageTs } = actionContext(action, body);
  if (!dispute?.id) {
    console.error('[server] approve_dispute: bad button payload', action.value);
    return;
  }

  if (!(await checkApprover(body, messageTs, 'Approve & Generate Evidence'))) return;

  if (approvalsInFlight.has(dispute.id)) {
    console.log(`[server] approve_dispute: ${dispute.id} already in flight — ignoring duplicate click`);
    if (messageTs) {
      await postFollowUp(messageTs, ':hourglass_flowing_sand: Approval already in progress for this dispute — hang tight, ignoring the extra click.').catch(() => {});
    }
    return;
  }
  approvalsInFlight.add(dispute.id);

  // Try in-memory state first; if missing (Render idle-sleep wiped it),
  // re-run the investigation from scratch so we have analysis + booking +
  // messages + contacts to feed into evidence generation. If state DOES
  // exist and includes a narrative from a prior Update Narrative click,
  // the cached analysis already incorporates it — no need to redo work.
  let state = getDisputeState(dispute.id);
  if (!state) {
    console.log(`[server] approve_dispute: state miss for ${dispute.id}, re-analysing cold (no narrative recovery possible)`);
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
      approvalsInFlight.delete(dispute.id);
      return;
    }
  }

  try {
    // Prefer the most recent Upload Evidence PDF posted to the dispute's
    // Slack thread. That PDF contains the ops-curated exhibits + the latest
    // narrative-driven framing; regenerating from analysis state would drop
    // the uploaded screenshots (Khushbu Aggarwal $50 case 2026-05-21 was
    // the canonical reproducer). Falls back to building a fresh PDF when
    // no prior Upload Evidence PDF exists in the thread (legacy disputes,
    // or first-time ops approval without an earlier review pass).
    const threadCoords = {
      channelId: state.channel_id || process.env.SLACK_CHANNEL_ID,
      threadTs: messageTs || state.message_ts,
    };

    let docxBuffer = null;
    let pdfSource;
    if (threadCoords.channelId && threadCoords.threadTs) {
      const existing = await fetchLatestEvidencePdfFromThread(threadCoords);
      if (existing) {
        docxBuffer = existing.buffer;
        pdfSource = `slack-thread (${existing.filename}, ${existing.buffer.length} bytes)`;
        console.log(
          `[server] approve_dispute: reusing PDF from thread for ${dispute.id} — ${pdfSource}`
        );
      }
    }

    if (!docxBuffer) {
      const paymentAuth = await getPaymentAuthForDispute(dispute);
      docxBuffer = await generateEvidence({
        analysis: state.analysis,
        dispute,
        booking: state.booking,
        platformMessages: state.messages || [],
        allContacts: state.all_contacts || [],
        paymentAuth,
      });
      pdfSource = 'generated-from-analysis (no prior Upload Evidence PDF in thread)';
      console.log(
        `[server] approve_dispute: built fresh PDF for ${dispute.id} — ${pdfSource}`
      );
    }

    const { account, dueBy } = await submitEvidence(dispute.id, state.analysis, state.booking, docxBuffer);

    const ts = new Date().toISOString();
    const deadlineLine = dueBy
      ? `\n:alarm_clock: *Respond-by deadline: ${new Date(dueBy * 1000).toUTCString()}* — the draft is worthless if nobody presses Submit before then.`
      : '';
    await updateMessage(
      messageTs || state.message_ts,
      `:memo: Evidence DRAFT saved to Stripe at ${ts} (PDF source: ${pdfSource})\n` +
        `:warning: *NOT yet submitted to the bank.* Open the dispute in the Stripe dashboard (${account.toUpperCase()} account) and press *Submit evidence*.` +
        deadlineLine
    );
  } catch (err) {
    console.error(`[server] Error approving dispute ${dispute.id}:`, err);
    if (messageTs || state.message_ts) {
      await postFollowUp(messageTs || state.message_ts, `:x: Error submitting evidence: ${err.message}`);
    }
  } finally {
    approvalsInFlight.delete(dispute.id);
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
  // Read cached narrative (if Update Narrative was clicked earlier in this
  // session AND state survived idle-sleep) and pre-fill the modal's
  // narrative field with it. Lets ops use Upload Evidence as a one-stop
  // shop without re-pasting on the common path; falls back to an empty
  // editable field if state is gone.
  const cachedState = getDisputeState(dispute.id);
  const cachedNarrative = cachedState?.narrative || null;
  try {
    await openEvidenceUploadModal({
      triggerId: body.trigger_id,
      dispute,
      channelId,
      messageTs,
      cachedNarrative,
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

  // Parse per-file descriptions (one line per file, in upload order). When
  // every line is blank, we switch to auto-mode and ask Gemini Vision to
  // describe each image. Mixed mode is also supported: a non-blank line
  // overrides the auto description for that file.
  const descriptionsText =
    view.state.values?.descriptions_block?.descriptions_input?.value || '';
  const descriptionLines = descriptionsText.split('\n');
  const hasAnyManualDescription = descriptionLines.some((l) => l.trim().length > 0);

  console.log(
    `[server] Evidence upload: ${dispute.id} — ${files.length} file(s) by user ${body.user?.id} (mode: ${hasAnyManualDescription ? 'manual/mixed' : 'auto'})`
  );

  try {
    // Re-run analysis for fresh booking/messages/contacts. The narrative
    // can come from three places (in priority order):
    //   1. The modal's narrative field (what ops just submitted) — most
    //      authoritative; survives Render idle-sleep because it travels
    //      in the view submission.
    //   2. Cached disputeState.narrative — only useful when ops didn't
    //      retype anything and state survived since the prior Update
    //      Narrative click.
    //   3. Empty — cold re-analysis with Gmail/booking signals only.
    //
    // The Khushbu Aggarwal $50 case 2026-05-20 was the canonical regression
    // that drove this: idle-sleep wiped state between Update Narrative and
    // Upload Evidence (1m44s apart), the agent re-analysed cold, missed
    // admission detection, and the PDF regressed from admission-framed to
    // LATE_COMPLAINT-framed. The modal field makes that impossible.
    const modalNarrative = (
      view.state.values?.upload_narrative_block?.upload_narrative_input?.value || ''
    ).trim();
    const priorState = getDisputeState(dispute.id);
    const cachedNarrative = priorState?.narrative || null;
    const narrativeToUse = modalNarrative || cachedNarrative || null;
    const narrativeSource = modalNarrative
      ? 'modal'
      : cachedNarrative
      ? 'cached-state'
      : 'none';
    console.log(
      `[server] upload_evidence: narrative source=${narrativeSource}` +
        (narrativeToUse ? ` (${narrativeToUse.length} chars)` : '') +
        ` for ${dispute.id}`
    );
    const result = await analyseDispute(dispute, narrativeToUse ? { narrative: narrativeToUse } : {});
    if (!result.booking) {
      throw new Error(`Booking lookup failed for ${dispute.payment_intent}`);
    }

    // Fetch each file as a Buffer via Slack's authenticated download URL.
    // Requires the bot token to have `files:read` scope.
    const fetchedFiles = []; // { buffer, filename, manualDescription }
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
      const manual = (descriptionLines[i] || '').trim();
      fetchedFiles.push({
        buffer,
        filename: f.name || f.title || `exhibit-${i + 1}`,
        manualDescription: manual,
      });
    }

    if (fetchedFiles.length === 0) {
      throw new Error('All file fetches failed — check bot has files:read scope');
    }

    // Auto-describe via Gemini Vision when any file lacks a manual line.
    // Sends the dispute analysis as context so the descriptions are framed
    // in merchant-counter terms (e.g. references the admission detected by
    // the agent, the rebuttal strategy, etc.). Falls back to filename-based
    // descriptions if the vision call fails.
    const needsAuto = fetchedFiles.some((f) => !f.manualDescription);
    let visionRecords = null;
    if (needsAuto) {
      try {
        visionRecords = await analyseExhibits({
          images: fetchedFiles.map((f) => ({ filename: f.filename, buffer: f.buffer })),
          dispute,
          analysis: result.analysis,
          booking: result.booking,
        });
      } catch (err) {
        console.error('[server] analyseExhibits threw (non-fatal):', err.message);
      }
    }

    // Assemble exhibits[]. For each fetched file: manual line wins; else
    // vision record; else filename fallback. When vision succeeded for the
    // whole set with no manual overrides, sort by relevance so the PDF
    // leads with the strongest exhibits.
    const exhibits = fetchedFiles.map((f, i) => {
      let description;
      let relevance = null;
      if (f.manualDescription) {
        description = f.manualDescription;
      } else if (visionRecords?.[i]) {
        description = formatExhibitDescription(visionRecords[i]);
        relevance = visionRecords[i].relevance;
      } else {
        description = f.filename || `Exhibit ${i + 1}`;
      }
      return { description, source: f.buffer, _relevance: relevance, _origIndex: i, _filename: f.filename };
    });

    // CURATION: when vision drove every description (auto mode), order by
    // relevance and drop ONLY what Vision flagged as irrelevant/unreadable. Ops
    // curates what they upload, so the agent must NOT second-guess and drop
    // relevant evidence (Aki's call 2026-06: "all the evidence should be
    // included"). The earlier ladder dropped MEDIUM whenever 2+ HIGH existed,
    // which silently cut the receipt + ingredient photos from the Brad no-show
    // pack down to 2 exhibits.
    //
    //   1. Drop NONE (wrong customer / off-topic / unreadable) — keeping these
    //      would look careless to a reviewer.
    //   2. Keep LOW / MEDIUM / HIGH — everything ops deliberately uploaded.
    //   3. Sort HIGH-first for ordering; hard cap at MAX_EXHIBITS as a backstop.
    //
    // Manual mode (ops typed descriptions) skips curation entirely.
    const MAX_EXHIBITS = 10;
    if (visionRecords && !hasAnyManualDescription) {
      const sortedVisionRecords = sortByRelevance(visionRecords);
      const byOrigIndex = new Map(exhibits.map((e) => [e._origIndex, e]));

      const droppedNone = [];
      const droppedOverCap = [];

      const kept = [];
      for (const r of sortedVisionRecords) {
        const exhibit = byOrigIndex.get(r.index);
        if (r.relevance === 'NONE') {
          droppedNone.push(`${r.filename}=${r.relevance}`);
          continue;
        }
        if (kept.length >= MAX_EXHIBITS) {
          droppedOverCap.push(`${r.filename}=${r.relevance}`);
          continue;
        }
        kept.push(exhibit);
      }

      exhibits.splice(0, exhibits.length, ...kept);

      console.log(
        `[server] Exhibit curation for ${dispute.id}: kept ${kept.length}/${sortedVisionRecords.length} (drop NONE only, cap=${MAX_EXHIBITS})`
      );
      if (droppedNone.length)
        console.log(`[server]   dropped NONE: ${droppedNone.join(', ')}`);
      if (droppedOverCap.length)
        console.log(`[server]   dropped over cap: ${droppedOverCap.join(', ')}`);
    }

    if (exhibits.length === 0) {
      throw new Error(
        'No exhibits passed curation — all uploaded files scored NONE (irrelevant/unreadable). ' +
          'Re-upload more relevant evidence, or supply manual descriptions to skip curation.'
      );
    }

    // Strip the private fields before passing downstream
    for (const e of exhibits) {
      delete e._relevance;
      delete e._origIndex;
      delete e._filename;
    }

    const customerName = `${result.booking.first_name || ''} ${result.booking.last_name || ''}`.trim() || 'Cardholder';
    const pdfBuffer = await generateEvidence({
      analysis: result.analysis,
      dispute: result.dispute || dispute,
      booking: result.booking,
      platformMessages: result.messages,
      allContacts: result.allContacts,
      exhibits,
      paymentAuth: result.paymentAuth,
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
  if (!(await checkApprover(body, messageTs, 'Escalate for Review'))) return;

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
  if (!(await checkApprover(body, messageTs, 'Dismiss'))) return;

  const ts = new Date().toISOString();
  await updateMessage(messageTs, `Dismissed at ${ts}`);
  console.log(`[server] Dispute ${dispute.id} dismissed`);
});

// Re-run a failed investigation. The button on an error post carries the raw
// dispute id (not an encoded dispute object). We re-fetch the dispute fresh
// from Stripe so the retry uses current data, then run the normal flow — which
// posts a fresh recommendation on success, or another error post (with its own
// retry button) on failure. This is the only self-serve way to reprocess a
// dispute after an outage, since Stripe fires charge.dispute.created just once.
slackApp.action('retry_investigation', async ({ action, ack, body }) => {
  await ack();
  const disputeId = typeof action.value === 'string' ? action.value : action.value?.id;
  const messageTs = body.message?.ts || body.container?.message_ts;
  if (!disputeId) {
    console.error('[server] retry_investigation: missing dispute id', action.value);
    return;
  }
  console.log(`[server] retry_investigation requested for ${disputeId}`);
  try {
    if (messageTs) {
      await postFollowUp(messageTs, `:arrows_counterclockwise: Re-running investigation for ${disputeId}…`);
    }
    const { fetchDisputeFromEitherAccount } = await import('./integrations/stripe.js');
    const { dispute } = await fetchDisputeFromEitherAccount(disputeId);

    // Don't resurrect a decided dispute: re-running posts a fresh review with
    // a live Approve button, and approving it would overwrite the evidence
    // that was already submitted (or fight a dispute that's already closed).
    const OPEN_STATUSES = new Set(['needs_response', 'warning_needs_response']);
    if (dispute.status && !OPEN_STATUSES.has(dispute.status)) {
      console.log(`[server] retry_investigation blocked for ${disputeId} — status is '${dispute.status}'`);
      if (messageTs) {
        await postFollowUp(
          messageTs,
          `:no_entry: Not re-running ${disputeId} — its Stripe status is *${dispute.status}*, so there's nothing left to investigate or submit. Check the dispute in the Stripe dashboard if this looks wrong.`
        );
      }
      return;
    }

    await investigateDispute(dispute);
  } catch (err) {
    console.error(`[server] retry_investigation failed for ${disputeId}:`, err);
    await reportInvestigationError('retry', { id: disputeId }, err);
  }
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

    // Idempotency: skip if we've already processed this Stripe event id
    // within the TTL window. Catches retries from cold-start timeouts.
    if (alreadyProcessedStripeEvent(event.id)) {
      console.log(`[stripe] Skipping duplicate event ${event.id} (${event.type})`);
      return;
    }

    // Route by event type. Other event types we don't subscribe to either
    // never reach here (Stripe dashboard filter) or we silently ignore.
    if (event.type === 'charge.dispute.created') {
      const dispute = event.data.object;
      console.log(`[stripe] Received dispute: ${dispute.id}`);
      // Post a durable breadcrumb BEFORE the 30-90s investigation: Stripe
      // sends this event exactly once, so a crash/redeploy mid-flight used to
      // lose the dispute silently. An orphaned breadcrumb (no review/error
      // below it) is the recovery signal, and it carries a Retry button.
      (async () => {
        const breadcrumbTs = await postInvestigationStarted(dispute);
        try {
          await investigateDispute(dispute);
          if (breadcrumbTs) {
            await updateMessage(
              breadcrumbTs,
              `:mag: ${dispute.id} — investigation complete; review posted below.`
            ).catch(() => {});
          }
        } catch (err) {
          await reportInvestigationError('webhook', dispute, err);
          if (breadcrumbTs) {
            await updateMessage(
              breadcrumbTs,
              `:mag: ${dispute.id} — investigation errored; see the error post below for next steps.`
            ).catch(() => {});
          }
        }
      })();
    } else if (event.type === 'charge.dispute.closed') {
      // Post the actual financial outcome (per Stripe's API view) to
      // #stripe-disputes. Added 2026-05-21 after the Katie Robertson Visa
      // 12.5 case where Stripe's "lost" label was a known UI lag and the
      // real money picture only surfaced via balance_transactions. The
      // helper formats both the formal status AND the API-derived net,
      // flagging cases where the two disagree so ops can spot Stripe's
      // delayed accounting (Katie-style) at a glance.
      const dispute = event.data.object;
      console.log(`[stripe] Dispute closed: ${dispute.id} (formal status: ${dispute.status})`);
      handleDisputeClosed(dispute).catch((err) =>
        reportInvestigationError('webhook-closed', dispute, err)
      );
    } else {
      // Other event types reach here only if the Stripe webhook config
      // subscribes to them — ignore silently. Logged below for future debug
      // if someone adds a subscription without updating this dispatcher.
      console.log(`[stripe] Ignoring unhandled event type: ${event.type}`);
    }
  }
);

/**
 * Handle a charge.dispute.closed webhook by deriving the actual financial
 * outcome from the Stripe API and posting it to #stripe-disputes (threaded
 * under the original dispute review when found, top-level otherwise).
 */
async function handleDisputeClosed(dispute) {
  const { getDisputeFinancialOutcome } = await import('./integrations/stripe.js');
  const { postDisputeOutcome } = await import('./integrations/slack.js');

  // The dispute object on the webhook event is canonical for status but
  // may not carry the full balance_transactions array — re-fetch via the
  // helper to ensure we have the latest financial picture.
  const outcome = await getDisputeFinancialOutcome(dispute.id);

  // Best-effort booking lookup for the customer-name display. Won't always
  // work (gift-card disputes have no BigQuery booking, see #18 Phase 2) —
  // fall back to "unknown customer" in that case.
  let booking = null;
  try {
    const { getBookingByPaymentId, getBookingByOrderId } = await import(
      './integrations/bigquery.js'
    );
    booking = await getBookingByPaymentId(dispute.payment_intent || dispute.charge);
    if (!booking) {
      const { fetchChargeFromEitherAccount } = await import('./integrations/stripe.js');
      try {
        const { charge } = await fetchChargeFromEitherAccount(dispute.charge);
        const orderId = charge?.metadata?.order_id;
        if (orderId) booking = await getBookingByOrderId(orderId);
      } catch {}
    }
  } catch (err) {
    console.warn(`[webhook-closed] Booking lookup failed for ${dispute.id} (non-fatal): ${err.message}`);
  }

  await postDisputeOutcome({ outcome, booking });
  console.log(
    `[webhook-closed] Posted outcome for ${dispute.id} — formal=${outcome.formalStatus}, ` +
      `net=${outcome.netDisplay} (${outcome.impliedOutcome}), disagrees=${outcome.statusDisagreesWithApi}`
  );
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Monthly dispute-ratio report — hit by cron-job.org on the 1st of each month.
// Posts the prior calendar month's US/UK dispute ratio to #stripe-disputes.
// Optional shared-secret guard: if REPORT_CRON_KEY is set, require ?key=<value>.
app.get('/reports/dispute-ratio', async (req, res) => {
  if (process.env.REPORT_CRON_KEY && req.query.key !== process.env.REPORT_CRON_KEY) {
    return res.status(403).json({ error: 'forbidden' });
  }
  res.json({ status: 'generating' }); // respond fast; compute + post async (~10s)
  try {
    const report = await getDisputeRatioReport();
    await postDisputeRatioReport(report);
    console.log(`[dispute-ratio] posted report for ${report.periodLabel}`);
  } catch (err) {
    console.error('[dispute-ratio] failed:', err.message);
  }
});

// Daily evidence-deadline check — hit by cron-job.org every morning.
// Scans both Stripe accounts for open disputes and posts a Slack alert when
// any is due within 48h (or has no visible due date). Posts nothing on quiet
// days. Same optional shared-secret guard as /reports/dispute-ratio.
app.get('/reports/deadline-check', async (req, res) => {
  if (process.env.REPORT_CRON_KEY && req.query.key !== process.env.REPORT_CRON_KEY) {
    return res.status(403).json({ error: 'forbidden' });
  }
  res.json({ status: 'checking' }); // respond fast; scan + post async
  try {
    const open = await getOpenDisputeDeadlines();
    const posted = await postDeadlineAlert(open);
    console.log(`[deadline-check] ${open.length} open dispute(s); alert posted: ${posted}`);
  } catch (err) {
    console.error('[deadline-check] failed:', err.message);
    await postSlackError(`Deadline check failed: ${err.message}`, { job: 'deadline-check' }).catch(() => {});
  }
});

// Weekly dispute recap — hit by cron-job.org every Monday morning. New
// disputes / verdicts / money-on-the-line for the trailing 7 days, posted
// to RECAP_CHANNEL_ID (#y-combinator). Same guard as the other reports.
app.get('/reports/weekly-recap', async (req, res) => {
  if (process.env.REPORT_CRON_KEY && req.query.key !== process.env.REPORT_CRON_KEY) {
    return res.status(403).json({ error: 'forbidden' });
  }
  res.json({ status: 'generating' }); // respond fast; compute + post async
  try {
    const recap = await getDisputeRecap('weekly');
    await postWeeklyDisputeRecap(recap);
    console.log(`[weekly-recap] posted for ${recap.periodLabel}`);
  } catch (err) {
    console.error('[weekly-recap] failed:', err.message);
    await postSlackError(`Weekly dispute recap failed: ${err.message}`, { job: 'weekly-recap' }).catch(() => {});
  }
});

// Monthly dispute recap — hit by cron-job.org on the 1st of each month.
// Prior calendar month's filings + verdicts, plus a 6-month filed-cohort
// table (statuses as of post time) and win-rate scorecard.
app.get('/reports/monthly-recap', async (req, res) => {
  if (process.env.REPORT_CRON_KEY && req.query.key !== process.env.REPORT_CRON_KEY) {
    return res.status(403).json({ error: 'forbidden' });
  }
  res.json({ status: 'generating' }); // respond fast; compute + post async
  try {
    const recap = await getDisputeRecap('monthly');
    await postMonthlyDisputeRecap(recap);
    console.log(`[monthly-recap] posted for ${recap.periodLabel}`);
  } catch (err) {
    console.error('[monthly-recap] failed:', err.message);
    await postSlackError(`Monthly dispute recap failed: ${err.message}`, { job: 'monthly-recap' }).catch(() => {});
  }
});

// Test endpoint — triggers investigation with a known booking.
// Gated behind TEST_DISPUTE_KEY: it accepts an arbitrary payment_intent and
// pulls that customer's PII from BigQuery into Slack, so it must not sit open
// on a guessable public URL (GAN review ops-M1). When the env var is unset
// the endpoint is disabled entirely.
// Usage: curl -X POST "http://localhost:3000/test/dispute?key=$TEST_DISPUTE_KEY"
app.post('/test/dispute', express.json(), async (req, res) => {
  if (!process.env.TEST_DISPUTE_KEY || req.query.key !== process.env.TEST_DISPUTE_KEY) {
    return res.status(403).json({ error: 'forbidden — set TEST_DISPUTE_KEY on the service and pass ?key=' });
  }
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
