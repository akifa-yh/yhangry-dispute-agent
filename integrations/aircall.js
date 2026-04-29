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

// Compare two phone numbers ignoring spaces, hyphens, parens, and the leading +.
// Aircall returns raw_digits in spaced human format like "+44 7875 261733",
// which won't string-compare against our "+447875261733" without normalisation.
function digitsOnly(s) {
  return (s || '').replace(/\D/g, '');
}
function phonesMatch(a, b) {
  const da = digitsOnly(a);
  const db = digitsOnly(b);
  if (!da || !db) return false;
  // Exact match preferred
  if (da === db) return true;
  // Be tolerant of country-code prefix differences (e.g. one with leading
  // country code, the other without). Match if one is a suffix of the other,
  // requiring at least 9 digits of overlap to avoid false positives on short
  // common suffixes.
  const minLen = 9;
  if (da.length >= minLen && db.endsWith(da)) return true;
  if (db.length >= minLen && da.endsWith(db)) return true;
  return false;
}

/**
 * Fetch INBOUND calls from a specific customer phone number, after a given
 * unix timestamp.
 *
 * IMPORTANT: Aircall's `phone_number` query parameter is unreliable — in
 * testing it returned thousands of UNRELATED calls (different `raw_digits`)
 * for non-matching customer phones. So we treat the API as "give me all
 * inbound calls in this window" and filter client-side by `raw_digits`.
 *
 * Discovered when Tyler Nader's analysis kept showing "first contact at
 * 04:43 AM ET on Feb 14" — a call that didn't exist for his number.
 * The API was returning random UK numbers under +13479318844.
 */
export async function getInboundCalls(phoneE164, fromUnixTimestamp) {
  try {
    const phone = normalisePhone(phoneE164);
    if (!phone) return [];

    // Paginate Aircall results until we exhaust the time window. We can't
    // rely on the API filtering by phone, so we fetch and filter ourselves.
    // Cap at 200 records (4 pages of 50) so we don't iterate forever on
    // very busy time windows.
    const allCalls = [];
    let page = 1;
    const PER_PAGE = 50;
    const MAX_PAGES = 4;

    while (page <= MAX_PAGES) {
      const response = await axios.get('https://api.aircall.io/v1/calls', {
        auth: {
          username: process.env.AIRCALL_API_ID,
          password: process.env.AIRCALL_API_TOKEN,
        },
        params: {
          phone_number: phone, // best-effort hint; we still filter client-side
          from: fromUnixTimestamp,
          direction: 'inbound',
          order: 'asc',
          per_page: PER_PAGE,
          page,
        },
      });

      const calls = response.data?.calls || [];
      allCalls.push(...calls);
      if (calls.length < PER_PAGE) break;
      page += 1;
    }

    const matching = allCalls.filter((c) => phonesMatch(c.raw_digits, phone));

    if (allCalls.length > 0 && matching.length === 0) {
      console.log(
        `[aircall] No matching calls for ${phone} (Aircall returned ${allCalls.length} unrelated calls; client-side filter discarded all).`
      );
    } else if (matching.length > 0) {
      console.log(
        `[aircall] Filtered ${allCalls.length} → ${matching.length} matching calls for ${phone}`
      );
    }

    return matching.map((call) => ({
      timestamp_iso: new Date(call.started_at * 1000).toISOString(),
      type: call.voicemail ? 'voicemail' : 'call',
      duration_seconds: call.duration || 0,
      answered: call.answered_at != null,
      channel: 'aircall',
      raw_digits: call.raw_digits,
    }));
  } catch (err) {
    console.error('[aircall] Error fetching calls:', err.message);
    return [];
  }
}
