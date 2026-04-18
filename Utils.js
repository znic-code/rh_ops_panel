// ── UTILITY FUNCTIONS ─────────────────────────────────────────
// Pure helpers with no external dependencies.

/** Format a number as "0.00" for currency display. */
function formatCurrency(n) { return parseFloat(n || 0).toFixed(2); }

/** Escape special regex characters so placeholders can be used with replaceText(). */
function escapeRegex(str) { return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Add `days` to an ISO date string and return a new ISO date string. */
function _addDays(isoDate, days) {
  var d = new Date(isoDate + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

/** Convert "2026-03-15" → "March 15, 2026" for display in the doc. */
function _formatDateForDoc(iso) {
  var d = new Date(iso + 'T12:00:00');
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}
