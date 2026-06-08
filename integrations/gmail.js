/**
 * Gmail integration for the dispute agent (Tyler retro #11; chefs@ added 2026-06).
 *
 * Pulls recent correspondence from TWO yhangry inboxes so Gemini can reconstruct
 * what happened from both sides:
 *   - info@yhangry.com  ↔ the CUSTOMER  (admissions, complaints, currency confusion)
 *   - chefs@yhangry.com ↔ the CHEF      (the chef's account of the day + any proof
 *                                        they sent: photos, timestamps, drive-time)
 *
 * Each inbox is a SEPARATE Google mailbox, so each needs its own OAuth refresh
 * token (the same Google Cloud OAuth client can issue both — just authorise each
 * mailbox once via the OAuth Playground):
 *   - GMAIL_CLIENT_ID            (shared OAuth client)
 *   - GMAIL_CLIENT_SECRET        (shared OAuth client)
 *   - GMAIL_REFRESH_TOKEN        (authorised as info@yhangry.com)
 *   - GMAIL_CHEFS_REFRESH_TOKEN  (authorised as chefs@yhangry.com)
 *
 * Gated on GMAIL_ENABLED. The chef fetch additionally ships "dark" until
 * GMAIL_CHEFS_REFRESH_TOKEN is set — fetchChefCorrespondence returns [] until then,
 * so the agent keeps working with just the customer inbox in the meantime.
 *
 * Lazy init (per memory's "ES module hoisting + lazy init" gotcha): clients are
 * constructed on first use so dotenv env vars are available.
 */

import { google } from 'googleapis';

function buildGmailClient(refreshToken) {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'Gmail OAuth credentials missing — need GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, and a refresh token'
    );
  }
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
  oauth2.setCredentials({ refresh_token: refreshToken });
  return google.gmail({ version: 'v1', auth: oauth2 });
}

let _gmailClient = null;
function gmailClient() {
  if (!_gmailClient) _gmailClient = buildGmailClient(process.env.GMAIL_REFRESH_TOKEN);
  return _gmailClient;
}

let _chefsGmailClient = null;
function chefsGmailClient() {
  if (!_chefsGmailClient) _chefsGmailClient = buildGmailClient(process.env.GMAIL_CHEFS_REFRESH_TOKEN);
  return _chefsGmailClient;
}

function gmailEnabled() {
  return process.env.GMAIL_ENABLED === 'true';
}

/**
 * Decode a Gmail message part. Gmail returns bodies base64url-encoded; we
 * concatenate the text/plain parts (preferred) or text/html stripped to
 * text. Returns a plain-text string.
 */
function decodeMessageBody(payload) {
  if (!payload) return '';

  // Top-level body (simple messages)
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf-8');
  }

  // Multipart — walk parts depth-first, prefer text/plain
  const parts = payload.parts || [];
  let plain = '';
  let html = '';
  for (const part of parts) {
    if (part.mimeType === 'text/plain' && part.body?.data) {
      plain += Buffer.from(part.body.data, 'base64url').toString('utf-8') + '\n';
    } else if (part.mimeType === 'text/html' && part.body?.data) {
      html += Buffer.from(part.body.data, 'base64url').toString('utf-8') + '\n';
    } else if (part.parts) {
      // Nested multipart (e.g. multipart/alternative inside multipart/mixed)
      const inner = decodeMessageBody(part);
      if (inner) plain += inner + '\n';
    }
  }

  if (plain.trim()) return plain.trim();
  if (html.trim()) {
    // Strip HTML tags + decode common entities for a readable plain-text fallback
    return html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }
  return '';
}

function headerValue(headers, name) {
  if (!headers) return null;
  const h = headers.find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value || null;
}

/**
 * Shared fetch: pull recent correspondence between the authorised mailbox and a
 * peer email address. Returns plain-text message objects sorted oldest → newest.
 * Non-fatal throughout — any error degrades to [].
 *
 * @param {Function} clientGetter - returns the gmail client for the target inbox
 * @param {string} peerEmail - the other party's email (customer or chef)
 * @param {string} label - 'customer' | 'chef', for logging
 * @param {object} [options] - { daysBack=90, maxMessages=30 }
 */
async function fetchCorrespondence(clientGetter, peerEmail, label, options = {}) {
  if (!peerEmail) return [];

  const { daysBack = 90, maxMessages = 30 } = options;
  const sanitizedEmail = peerEmail.replace(/["'\\]/g, '');
  const sinceDays = Math.max(1, Math.floor(daysBack));
  const query = `(from:${sanitizedEmail} OR to:${sanitizedEmail}) newer_than:${sinceDays}d`;

  let gmail;
  try {
    gmail = clientGetter();
  } catch (err) {
    console.warn(`[gmail] ${label} client init failed (skipping): ${err.message}`);
    return [];
  }

  let listRes;
  try {
    listRes = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: maxMessages });
  } catch (err) {
    console.warn(`[gmail] ${label} list failed for ${peerEmail}: ${err.message}`);
    return [];
  }

  const messages = listRes.data.messages || [];
  if (messages.length === 0) {
    console.log(`[gmail] No ${label} messages for ${peerEmail} (window: ${sinceDays}d)`);
    return [];
  }

  const results = await Promise.allSettled(
    messages.map((m) => gmail.users.messages.get({ userId: 'me', id: m.id, format: 'full' }))
  );

  const decoded = [];
  for (const r of results) {
    if (r.status !== 'fulfilled') {
      console.warn(`[gmail] ${label} message fetch failed: ${r.reason?.message}`);
      continue;
    }
    const msg = r.value.data;
    const headers = msg.payload?.headers || [];
    const body = decodeMessageBody(msg.payload);
    decoded.push({
      id: msg.id,
      threadId: msg.threadId,
      date: headerValue(headers, 'Date'),
      from: headerValue(headers, 'From'),
      to: headerValue(headers, 'To'),
      subject: headerValue(headers, 'Subject'),
      snippet: msg.snippet || '',
      body: body.slice(0, 4000), // cap each message to keep prompt size manageable
    });
  }

  decoded.sort((a, b) => {
    const da = a.date ? new Date(a.date).getTime() : 0;
    const db = b.date ? new Date(b.date).getTime() : 0;
    return da - db;
  });

  console.log(`[gmail] Fetched ${decoded.length} ${label} message(s) for ${peerEmail} (window: ${sinceDays}d)`);
  return decoded;
}

/**
 * Fetch recent correspondence between info@yhangry.com and the CUSTOMER.
 * Returns [] when GMAIL_ENABLED is off, the email is missing, or no matches.
 */
export async function fetchCustomerCorrespondence(customerEmail, options = {}) {
  if (!gmailEnabled()) return [];
  return fetchCorrespondence(gmailClient, customerEmail, 'customer', options);
}

/**
 * Fetch recent correspondence between chefs@yhangry.com and the CHEF.
 * Ships dark: returns [] until GMAIL_CHEFS_REFRESH_TOKEN is set (chefs@ authorised),
 * so the agent runs on the customer inbox alone in the meantime.
 */
export async function fetchChefCorrespondence(chefEmail, options = {}) {
  if (!gmailEnabled()) return [];
  if (!process.env.GMAIL_CHEFS_REFRESH_TOKEN) {
    return []; // chefs@ not authorised yet — feature inert
  }
  return fetchCorrespondence(chefsGmailClient, chefEmail, 'chef', options);
}
