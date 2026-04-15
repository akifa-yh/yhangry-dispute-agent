import axios from 'axios';

const BASE = 'https://api.bird.com';

function headers() {
  return {
    Authorization: `AccessKey ${process.env.BIRD_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

async function findContact(phoneE164) {
  const workspaceId = process.env.BIRD_WORKSPACE_ID;

  // Use POST search with identifier object
  const res = await axios.post(
    `${BASE}/workspaces/${workspaceId}/contacts/search`,
    { identifier: { key: 'phonenumber', value: phoneE164 } },
    { headers: headers() }
  );

  const contacts = res.data?.results || [];
  return contacts[0]?.id || null;
}

async function getMessages(contactId) {
  const workspaceId = process.env.BIRD_WORKSPACE_ID;
  const channelId = process.env.BIRD_WHATSAPP_CHANNEL_ID;

  // Try channel-specific messages for this contact
  const res = await axios.get(
    `${BASE}/workspaces/${workspaceId}/channels/${channelId}/contacts/${contactId}/messages`,
    { headers: headers() }
  );

  return res.data?.results || res.data?.data || [];
}

export async function getInboundMessages(phoneE164, fromIsoDate) {
  try {
    const contactId = await findContact(phoneE164);
    if (!contactId) {
      console.log('[bird] No contact found for phone:', phoneE164);
      return [];
    }

    console.log('[bird] Found contact:', contactId);

    let messages;
    try {
      messages = await getMessages(contactId);
    } catch (msgErr) {
      // If channel-level messages fail, return empty
      console.error('[bird] Error fetching messages for contact:', msgErr.response?.status, msgErr.response?.data?.message || msgErr.message);
      return [];
    }

    const fromDate = new Date(fromIsoDate);

    return messages
      .filter(
        (m) =>
          m.direction === 'incoming' && new Date(m.createdAt) >= fromDate
      )
      .map((m) => ({
        timestamp_iso: m.createdAt,
        type: 'whatsapp',
        body_preview: (m.body?.text || m.content || '').slice(0, 200),
        channel: 'bird',
      }));
  } catch (err) {
    console.error('[bird] Error:', err.response?.status, err.response?.data?.message || err.message);
    return [];
  }
}
