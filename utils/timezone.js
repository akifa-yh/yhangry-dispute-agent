import { DateTime } from 'luxon';
import { find as findTimezone } from 'geo-tz';
import zipcodes from 'zipcodes';

const UK_POSTCODE_RE = /^[A-Z]{1,2}[0-9]/i;
const US_ZIP_RE = /^\d{5}$/;
const US_ZIP_PLUS4_RE = /^(\d{5})-\d{4}$/; // e.g. "06907-1512"
const UAE_POSTCODES = /^(0|00)?[1-9]\d{0,4}$/; // simplified UAE detection

function detectTimezone(postcode) {
  const trimmed = (postcode || '').trim();

  // UK postcode
  if (UK_POSTCODE_RE.test(trimmed)) {
    return 'Europe/London';
  }

  // US zip code (5-digit or ZIP+4 like "06907-1512")
  const plus4Match = trimmed.match(US_ZIP_PLUS4_RE);
  const baseZip = plus4Match ? plus4Match[1] : (US_ZIP_RE.test(trimmed) ? trimmed : null);
  if (baseZip) {
    const lookup = zipcodes.lookup(baseZip);
    if (lookup) {
      const zones = findTimezone(lookup.latitude, lookup.longitude);
      if (zones.length > 0) return zones[0];
    }
    console.warn(`[timezone] US zip ${baseZip} — could not resolve timezone, falling back to America/New_York`);
    return 'America/New_York';
  }

  // Dubai / UAE — known patterns
  if (/^(Dubai|UAE)/i.test(trimmed) || UAE_POSTCODES.test(trimmed)) {
    return 'Asia/Dubai';
  }

  // Thailand
  if (/^[1-9]\d{4}$/.test(trimmed) && parseInt(trimmed) >= 10000 && parseInt(trimmed) <= 96220) {
    // Thai postcodes are 5 digits, 10000-96220 range
    return 'Asia/Bangkok';
  }

  console.warn(`[timezone] Unrecognised postcode format: "${trimmed}" — falling back to UTC`);
  return 'UTC';
}

export function getComplaintDeadline(postcode, mealDateString) {
  const timezone = detectTimezone(postcode);

  const deadline = DateTime.fromISO(mealDateString, { zone: timezone })
    .plus({ days: 1 })
    .set({ hour: 12, minute: 0, second: 0, millisecond: 0 });

  return {
    deadline_iso: deadline.toISO(),
    timezone,
  };
}
