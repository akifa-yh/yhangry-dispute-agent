import axios from 'axios';

const convexUrl = () => process.env.CONDUIT_CONVEX_URL;

function authHeaders() {
  return { Authorization: `Bearer ${process.env.CONDUIT_BEARER_TOKEN}` };
}

// NOTE: Conduit API paths need to be verified with the dev team.
// The paths from the original spec no longer resolve (404).
// When correct paths are confirmed, update the URLs below.
// For now, all functions fail gracefully and return empty results.

export async function searchContact(email) {
  try {
    // TODO: Get correct Convex function path from dev team
    const res = await axios.post(
      `${convexUrl()}/api/run/mcp/internal/searchContactsPublic`,
      {
        args: {
          workspaceId: process.env.CONDUIT_WORKSPACE_ID,
          searchQuery: email,
          limit: 5,
        },
      },
      { headers: authHeaders() }
    );

    const contacts = res.data || [];
    return contacts[0]?.contactId || contacts[0]?.id || null;
  } catch (err) {
    // Only log if it's not the expected 404 (path not found)
    if (err.response?.status !== 404) {
      console.error('[conduit] Error searching contact:', err.response?.status, err.response?.data?.message || err.message);
    } else {
      console.log('[conduit] Contact search endpoint not configured (404) — skipping');
    }
    return null;
  }
}

export async function getContactMessages(contactId) {
  try {
    const res = await axios.post(
      `${convexUrl()}/api/run/contacts/controllers/inbox/messages/getRecentMessages`,
      { args: { contactId } },
      { headers: authHeaders() }
    );

    const messages = res.data || [];
    return messages
      .filter((m) => m.direction === 'inbound' || m.direction === 'incoming')
      .map((m) => ({
        timestamp_iso: m.createdAt || m.timestamp,
        type: 'email',
        body_preview: (m.body || m.text || '').slice(0, 200),
        channel: 'conduit',
      }));
  } catch (err) {
    if (err.response?.status !== 404) {
      console.error('[conduit] Error fetching messages:', err.response?.status, err.response?.data?.message || err.message);
    }
    return [];
  }
}

export async function getContactTickets(contactId) {
  try {
    const res = await axios.post(
      `${convexUrl()}/api/run/conversations/ticket/queries/listTicketsForContact`,
      { args: { contactId } },
      { headers: authHeaders() }
    );

    const tickets = res.data || [];
    return tickets.map((t) => ({
      timestamp_iso: t.createdAt || t.timestamp,
      type: 'ticket',
      subject: t.subject || t.title || '',
      status: t.status || '',
      channel: 'conduit',
    }));
  } catch (err) {
    if (err.response?.status !== 404) {
      console.error('[conduit] Error fetching tickets:', err.response?.status, err.response?.data?.message || err.message);
    }
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
