// ── EXPENSE SERVICE ──────────────────────────────────────────
// Expense logging with optional receipt upload and AI extraction.

/**
 * Log a new expense linked to a project/client.
 *
 * @param {Object} data
 * @param {string} [data.expenseId]     Expense ID (auto-generated if blank)
 * @param {string} data.description
 * @param {string} [data.projectId]     Notion page ID
 * @param {string} [data.clientId]      Notion page ID
 * @param {string} data.category        Gear / Travel / Contractor / Software / Other
 * @param {string} [data.type]          Project / Overhead
 * @param {number} data.amount
 * @param {string} data.expenseDate     ISO date
 * @param {string} [data.vendor]
 * @param {boolean} [data.billable]
 * @param {string} [data.contractorId]  Notion page ID
 * @param {string} [data.receiptUrl]    Drive file URL (set by receipt upload flow)
 * @param {string} [data.status]        Logged / Needs Review
 * @param {string} [data.notes]
 * @returns {Object} { success, expense, error? }
 */
function logExpense(data) {
  try {
    // Validate required fields — relaxed for "Needs Review" status (iOS Shortcut drafts)
    var isReview = data.status === 'Needs Review';
    if (!isReview && (!data.description || !data.description.trim())) {
      return { success: false, error: 'Expense description is required.' };
    }
    if (!isReview && (!data.amount || parseFloat(data.amount) <= 0)) {
      return { success: false, error: 'Amount must be greater than zero.' };
    }

    // Auto-generate expense ID if not provided
    var expenseId = data.expenseId || _generateExpenseId(data.expenseDate);

    var page = createNotionExpense({
      expenseId:    expenseId,
      description:  data.description,
      type:         data.type || '',
      projectId:    data.projectId || '',
      clientId:     data.clientId || '',
      contractorId: data.contractorId || '',
      category:     data.category || 'Other',
      amount:       data.amount,
      expenseDate:  data.expenseDate || new Date().toISOString().split('T')[0],
      vendor:       data.vendor || '',
      billable:     data.billable || false,
      receiptUrl:   data.receiptUrl || '',
      status:       data.status || 'Logged',
      notes:        data.notes || '',
    });
    return {
      success: true,
      expense: {
        id:          page.id,
        expenseId:   expenseId,
        description: data.description,
        notionUrl:   page.url || '',
      },
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Generate an expense ID in the format: RH-EXP-YY-MMDD-NN
 * Uses LockService to prevent duplicates.
 *
 * @param {string} [dateStr]  ISO date to use (defaults to today)
 * @returns {string} e.g., "RH-EXP-26-0318-01"
 */
function _generateExpenseId(dateStr) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(5000);
    var d = dateStr ? new Date(dateStr + 'T12:00:00') : new Date();
    var yy = String(d.getFullYear()).slice(-2);
    var mm = String(d.getMonth() + 1).padStart(2, '0');
    var dd = String(d.getDate()).padStart(2, '0');
    var prefix = 'RH-EXP-' + yy + '-' + mm + dd;

    // Check existing expenses for today's prefix to find next sequence number
    var props = PropertiesService.getScriptProperties();
    var lastKey = '_lastExpenseId';
    var last = props.getProperty(lastKey) || '';
    var seq = 1;

    if (last.indexOf(prefix) === 0) {
      // Same day — increment sequence
      var lastSeq = parseInt(last.split('-').pop(), 10) || 0;
      seq = lastSeq + 1;
    }

    var id = prefix + '-' + String(seq).padStart(2, '0');
    props.setProperty(lastKey, id);
    return id;
  } finally {
    lock.releaseLock();
  }
}
