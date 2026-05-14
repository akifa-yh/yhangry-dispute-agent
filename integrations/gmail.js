/**
 * Gmail integration for the dispute agent (Tyler retro #11).
 *
 * Pulls recent correspondence between yhangry's info@ inbox and a customer's
 * email address, so Gemini can spot patterns like:
 *   - Customer admissions ("I'll cancel the dispute", "filed in error",
 *     "my apologies") — strongest possible counter-evidence
 *   - Direct customer complaints that bypass yhangry's complaint channels
 *   - Currency/pricing confusion (12.x dispute pattern)
 *
 * Gated on GMAIL_ENABLED env var — when false, the fetch returns an empty
 * list silently and the rest of the analysis runs as before. This lets us
 * ship the integration code "dark" before the OAuth setup is complete.
 *
 * Authentication: OAuth2 with a long-lived refresh token. Setup via Google
 * OAuth Playground (see #11 phase B in dispute_agent_state.md):
 *   - GMAIL_CLIENT_ID         (from Google Cloud OAuth client)
 *   - GMAIL_CLIENT_SECRET     (from Google Cloud OAuth client)
 *   - GMAIL_REFRESH_TOKEN     (from OAuth Playground, authorised as info@yhangry.com)
 *
 * Lazy init pattern (per memory's "ES module hoisting + lazy init" gotcha):
 * the OAuth2 client and Gmail API client are constructed on first use, not
 * at module load, so env vars from dotenv are guaranteed to be available.
 */

import { google } from 'googleapis';

let _gmailClient = null;

function gmailClient() {
  if (_gmailClient) return _gmailClient;

  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'Gmail OAuth credentials missing — set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN'
    );
  }

  const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
  oauth2.setCredentials({ refresh_token: refreshToken });

  _gmailClient = google.gmail({ version: 'v1', auth: oauth2 });
  return _gmailClient;
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
 * Fetch recent correspondence between info@yhangry.com and a customer.
 *
 * Returns an array of plain-text message objects, sorted oldest → newest:
 *   { id, threadId, date, from, to, subject, snippet, body }
 *
 * Empty array when:
 *   - GMAIL_ENABLED is not 'true' (feature flag off)
 *   - customerEmail is missing/empty
 *   - Gmail API returns no matches
 *
 * @param {string} customerEmail - customer's email address (from booking)
 * @param {object} [options]
 * @param {number} [options.daysBack=90] - lookback window
 * @param {number} [options.maxMessages=10] - cap on messages returned (most
 *   recent kept if more match)
 */
export async function fetchCustomerCorrespondence(customerEmail, options = {}) {
  if (!gmailEnabled()) {
    return [];
  }
  if (!customerEmail) {
    return [];
  }

  const { daysBack = 90, maxMessages = 10 } = options;
  const sanitizedEmail = customerEmail.replace(/["'\\]/g, '');
  const sinceDays = Math.max(1, Math.floor(daysBack));

  // Gmail query syntax: -from:foo means exclude. Here we want messages
  // where the customer is either sender or recipient.
  const query = `(from:${sanitizedEmail} OR to:${sanitizedEmail}) newer_than:${sinceDays}d`;

  let gmail;
  try {
    gmail = gmailClient();
  } catch (err) {
    console.warn(`[gmail] Client init failed (Gmail integration disabled): ${err.message}`);
    return [];
  }

  let listRes;
  try {
    listRes = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: maxMessages,
    });
  } catch (err) {
    console.warn(`[gmail] List failed for ${customerEmail}: ${err.message}`);
    return [];
  }

  const messages = listRes.data.messages || [];
  if (messages.length === 0) {
    console.log(`[gmail] No messages found for ${customerEmail} (window: ${sinceDays}d)`);
    return [];
  }

  // Fetch full message bodies (in parallel)
  const results = await Promise.allSettled(
    messages.map((m) =>
      gmail.users.messages.get({ userId: 'me', id: m.id, format: 'full' })
    )
  );

  const decoded = [];
  for (const r of results) {
    if (r.status !== 'fulfilled') {
      console.warn(`[gmail] Message fetch failed: ${r.reason?.message}`);
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

  // Sort oldest → newest for chronological context
  decoded.sort((a, b) => {
    const da = a.date ? new Date(a.date).getTime() : 0;
    const db = b.date ? new Date(b.date).getTime() : 0;
    return da - db;
  });

  console.log(`[gmail] Fetched ${decoded.length} message(s) for ${customerEmail} (window: ${sinceDays}d)`);
  return decoded;
}
