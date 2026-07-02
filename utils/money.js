// Currency-aware money formatting, shared by every surface that renders a
// dispute amount (Slack posts, LLM prompts, PDF, error posts). Hardcoded "$"
// mis-rendered every GBP (UK-account) dispute as dollars — including in the
// text shown to Gemini, which could leak "$520" phrasing into bank-facing
// rebuttal copy (GAN review 2026-07-02). Unknown currencies render as
// "123.45 XYZ" rather than guessing a symbol.
const CURRENCY_SYMBOLS = { usd: '$', gbp: '£', eur: '€', aud: 'A$', cad: 'C$' };

export function formatMoney(amountMinor, currency) {
  const cur = String(currency || '').toLowerCase();
  const amt = (Number(amountMinor || 0) / 100).toFixed(2);
  if (!cur) return `$${amt}`; // legacy callers with no currency in scope
  const sym = CURRENCY_SYMBOLS[cur];
  return sym ? `${sym}${amt}` : `${amt} ${cur.toUpperCase()}`.trim();
}
