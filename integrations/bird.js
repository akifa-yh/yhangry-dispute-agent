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

  const res = await axios.post(
    `${BASE}/workspaces/${workspaceId}/contacts/search`,
    { identifier: { key: 'phonenumber', value: phoneE164 } },
    { headers: headers() }
  );

  const contacts = res.data?.results || [];
  return contacts[0] || null;
}

async function getConversationMessages(conversationId) {
  const workspaceId = process.env.BIRD_WORKSPACE_ID;

  const res = await axios.get(
    `${BASE}/workspaces/${workspaceId}/conversations/${conversationId}/messages`,
    { headers: headers(), params: { limit: 50 } }
  );

  return res.data?.results || [];
}

export async function getInboundMessages(phoneE164, fromIsoDate) {
  try {
    const contact = await findContact(phoneE164);
    if (!contact) {
      console.log('[bird] No contact found for phone:', phoneE164);
      return [];
    }

    console.log(`[bird] Found contact: ${contact.id} (${contact.computedDisplayName})`);

    // Get all conversations and find ones involving this contact
    const workspaceId = process.env.BIRD_WORKSPACE_ID;
    const convRes = await axios.get(
      `${BASE}/workspaces/${workspaceId}/conversations`,
      { headers: headers(), params: { limit: 50 } }
    );

    const conversations = convRes.data?.results || [];
    const fromDate = new Date(fromIsoDate);
    const allMessages = [];

    // Check each conversation for this contact as participant
    for (const conv of conversations) {
      const participants = conv.featuredParticipants || [];
      const contactInConv = participants.some(
        (p) => p.contact?.identifierValue === phoneE164 ||
               p.displayName === contact.computedDisplayName
      );

      if (!contactInConv) continue;

      console.log(`[bird] Found conversation ${conv.id.slice(0, 8)} with ${contact.computedDisplayName}`);

      try {
        const messages = await getConversationMessages(conv.id);
        for (const m of messages) {
          const isIncoming = m.sender?.type === 'contact';
          const msgDate = new Date(m.createdAt);

          if (msgDate >= fromDate) {
            allMessages.push({
              timestamp_iso: m.createdAt,
              type: 'whatsapp',
              body_preview: (m.body?.text?.text || m.body?.html?.html || '').slice(0, 200),
              channel: 'bird',
              direction: isIncoming ? 'incoming' : 'outgoing',
            });
          }
        }
      } catch (msgErr) {
        console.error(`[bird] Error fetching messages for conversation ${conv.id.slice(0, 8)}:`, msgErr.response?.status);
      }
    }

    // If no messages found but contact exists, still report the contact was found
    if (allMessages.length === 0 && contact) {
      console.log('[bird] Contact exists but no recent WhatsApp messages found');
    }

    return allMessages
      .filter((m) => m.direction === 'incoming')
      .sort((a, b) => new Date(a.timestamp_iso) - new Date(b.timestamp_iso));
  } catch (err) {
    console.error('[bird] Error:', err.response?.status, err.response?.data?.message || err.message);
    return [];
  }
}
