import axios from 'axios';

function normalisePhone(phone) {
  if (!phone) return null;
  let cleaned = phone.replace(/[\s\-()]/g, '');
  if (!cleaned.startsWith('+')) {
    if (cleaned.startsWith('00')) {
      // International with 00 prefix
      cleaned = '+' + cleaned.slice(2);
    } else if (cleaned.startsWith('0')) {
      // UK local format (07xxx)
      cleaned = '+44' + cleaned.slice(1);
    } else if (cleaned.startsWith('1') && cleaned.length === 10) {
      // US number without +
      cleaned = '+1' + cleaned;
    } else if (cleaned.length === 10 && cleaned.startsWith('7')) {
      // UK mobile without 0 prefix (7xxxxxxxxx)
      cleaned = '+44' + cleaned;
    } else if (cleaned.length === 11 && cleaned.startsWith('44')) {
      // UK number missing the +
      cleaned = '+' + cleaned;
    } else {
      // Default: assume UK
      cleaned = '+44' + cleaned;
    }
  }
  return cleaned;
}

export async function getInboundCalls(phoneE164, fromUnixTimestamp) {
  try {
    const phone = normalisePhone(phoneE164);
    if (!phone) return [];

    const response = await axios.get('https://api.aircall.io/v1/calls', {
      auth: {
        username: process.env.AIRCALL_API_ID,
        password: process.env.AIRCALL_API_TOKEN,
      },
      params: {
        phone_number: phone,
        from: fromUnixTimestamp,
        direction: 'inbound',
        order: 'asc',
        per_page: 50,
      },
    });

    const calls = response.data?.calls || [];

    return calls.map((call) => ({
      timestamp_iso: new Date(call.started_at * 1000).toISOString(),
      type: call.voicemail ? 'voicemail' : 'call',
      duration_seconds: call.duration || 0,
      answered: call.answered_at != null,
      channel: 'aircall',
    }));
  } catch (err) {
    console.error('[aircall] Error fetching calls:', err.message);
    return [];
  }
}
