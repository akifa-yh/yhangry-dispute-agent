import axios from 'axios';

const BASE = 'https://api.conduit.ai/v1';

function headers() {
  return { Authorization: `Bearer ${process.env.CONDUIT_API_TOKEN}` };
}

function wsParam() {
  return `workspace_id=${process.env.CONDUIT_WORKSPACE_ID}`;
}

export async function searchContact(email) {
  try {
    // Fetch contacts and filter by email client-side (API doesn't support server-side search)
    let cursor = null;
    let allContacts = [];

    // Paginate through contacts to find the one matching this email
    for (let page = 0; page < 10; page++) {
      const params = new URLSearchParams({
        workspace_id: process.env.CONDUIT_WORKSPACE_ID,
        ...(cursor ? { cursor } : {}),
      });

      const res = await axios.get(`${BASE}/contacts?${params}`, {
        headers: headers(),
        timeout: 10000,
      });

      const contacts = res.data?.data || [];
      allContacts.push(...contacts);

      // Check if we found the contact — email may be in first_name field or name might match.
      // CRITICAL: We must NOT use `emailLower.includes(fn)` — every string includes the empty
      // string, so any contact with an empty first_name would falsely match. (This caused
      // the Tyler dispute to "find" a Conduit contact named Chris at christaylor3000@hotmail.com.)
      const emailLower = email.toLowerCase();
      const localPart = email.split('@')[0].toLowerCase();
      const match = contacts.find((c) => {
        const fn = (c.first_name || '').trim().toLowerCase();
        const ln = (c.last_name || '').trim().toLowerCase();

        // Skip empty contacts — can't reliably match them
        if (!fn && !ln) return false;

        // Email-as-first_name (Conduit pattern for inbound emails from unknown contacts)
        if (fn === emailLower) return true;

        // Email contained somewhere in name fields (rare, but possible)
        if (fn.includes(emailLower) || ln.includes(emailLower)) return true;

        // Local-part heuristic. Local part of `tnader@mainstaymedical.com` is `tnader`.
        // We match if it appears as a substring in fn or ln. Require localPart to be at
        // least 4 chars to avoid false-positive matches on common short names like "tom"
        // or "ana" against unrelated contacts. Use word-boundary-ish check via space-pad.
        if (localPart.length >= 4) {
          const fullName = ` ${fn} ${ln} `;
          if (fullName.includes(localPart)) return true;
        }

        return false;
      });

      if (match) {
        console.log(`[conduit] Found contact: ${match.id} (${match.first_name} ${match.last_name})`);
        return match.id;
      }

      // Check for next page
      cursor = res.data?.next_cursor;
      if (!cursor || contacts.length === 0) break;
    }

    console.log(`[conduit] Contact not found for email: ${email} (searched ${allContacts.length} contacts)`);
    return null;
  } catch (err) {
    console.error('[conduit] Error searching contact:', err.response?.status, err.response?.data?.error || err.message);
    return null;
  }
}

export async function getContactMessages(contactId) {
  try {
    // In Conduit, conversation ID = contact ID
    const res = await axios.get(
      `${BASE}/conversations/${contactId}/messages?${wsParam()}`,
      { headers: headers(), timeout: 10000 }
    );

    const messages = res.data?.data || [];
    return messages.map((m) => ({
      timestamp_iso: m.created_at || m.sent_at,
      type: m.channel === 'email' ? 'email' : m.channel || 'message',
      body_preview: (m.body || '').slice(0, 200),
      direction: m.direction || 'unknown',
      channel: 'conduit',
    }));
  } catch (err) {
    console.error('[conduit] Error fetching messages:', err.response?.status, err.response?.data?.error || err.message);
    return [];
  }
}

export async function getContactTickets(contactId) {
  try {
    const res = await axios.get(
      `${BASE}/tickets?${wsParam()}&contact_id=${contactId}`,
      { headers: headers(), timeout: 10000 }
    );

    const tickets = res.data?.data || [];
    return tickets
      .filter((t) => t.contact_id === contactId || t.conversation_id === contactId)
      .map((t) => ({
        timestamp_iso: t.created_at,
        type: 'ticket',
        subject: t.subject || t.title || '',
        status: t.status || '',
        channel: 'conduit',
      }));
  } catch (err) {
    console.error('[conduit] Error fetching tickets:', err.response?.status, err.response?.data?.error || err.message);
    return [];
  }
}

export async function getAllContactActivity(email, fromIsoDate) {
  const contactId = await searchContact(email);
  if (!contactId) return [];

  const [messages, tickets] = await Promise.all([
    getContactMessages(contactId),
    getContactTickets(contactId),
  ]);

  const fromDate = new Date(fromIsoDate);
  return [...messages, ...tickets]
    .filter((item) => new Date(item.timestamp_iso) >= fromDate)
    .sort((a, b) => new Date(a.timestamp_iso) - new Date(b.timestamp_iso));
}
