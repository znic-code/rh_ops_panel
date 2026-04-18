// ── PAYMENT SERVICE ──────────────────────────────────────────
// Payment logging, invoice status flip, listing.

/**
 * Log a payment and optionally flip the related invoice to Paid.
 *
 * @param {Object} data
 * @param {string} [data.paymentId]     Payment ID (auto-generated if blank)
 * @param {string} [data.description]   Human-readable description
 * @param {string} [data.invoiceId]     Notion page ID of the invoice (optional)
 * @param {string} [data.clientId]      Notion page ID
 * @param {number} data.amount
 * @param {string} data.method          Check / ACH / Wire / Card / Zelle / Other
 * @param {string} data.paymentDate     ISO date
 * @param {boolean} [data.markPaid]     If true, flip invoice to Paid
 * @param {number} [data.amountWithheld] Amount withheld by client (withholding agents)
 * @param {string} [data.receiptUrl]
 * @param {string} [data.notes]
 * @returns {Object} { success, payment, invoiceUpdated?, error? }
 */
function logPayment(data) {
  try {
    // Relaxed validation for "Review" status (iOS Shortcut drafts)
    var isReview = data.status === 'Review';
    if (!isReview && (!data.amount || parseFloat(data.amount) <= 0)) {
      return { success: false, error: 'Amount must be greater than zero.' };
    }

    // Auto-generate payment ID if not provided
    var paymentId = data.paymentId && data.paymentId.trim()
      ? data.paymentId.trim()
      : _generatePaymentId(data.paymentDate);

    const page = createNotionPayment({
      paymentId:      paymentId,
      description:    data.description || '',
      invoiceId:      data.invoiceId || '',
      clientId:       data.clientId || '',
      amount:         data.amount,
      amountWithheld: parseFloat(data.amountWithheld) || 0,
      method:         data.method || 'Check',
      paymentDate:    data.paymentDate || new Date().toISOString().split('T')[0],
      status:         data.status || 'Logged',
      receiptUrl:     data.receiptUrl || '',
      notes:          data.notes || '',
    });

    var invoiceUpdated = false;
    if (data.markPaid && data.invoiceId) {
      updateInvoiceStatus(data.invoiceId, 'Paid', data.paymentDate || new Date().toISOString().split('T')[0]);
      invoiceUpdated = true;
    } else if (data.invoiceId) {
      // Auto-check: if received + withheld covers the invoice total (within $1 rounding), mark Paid
      var withheld = parseFloat(data.amountWithheld) || 0;
      if (withheld > 0) {
        var invoice = getInvoiceById(data.invoiceId);
        if (invoice && invoice.total > 0) {
          var existingPayments = getPaymentsByInvoice(data.invoiceId);
          var previousSettled = (existingPayments && !existingPayments.error)
            ? existingPayments.reduce(function(s, p) { return s + (p.amount || 0) + (p.amountWithheld || 0); }, 0)
            : 0;
          var totalSettled = previousSettled + parseFloat(data.amount) + withheld;
          if (invoice.total - totalSettled <= 1.00) {
            updateInvoiceStatus(data.invoiceId, 'Paid', data.paymentDate || new Date().toISOString().split('T')[0]);
            invoiceUpdated = true;
          }
        }
      }
    }

    return {
      success: true,
      payment: {
        id:        page.id,
        paymentId: paymentId,
        notionUrl: page.url || '',
      },
      invoiceUpdated: invoiceUpdated,
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Generate a payment ID in the format: RH-PAY-YY-MMDD-NN
 * Uses LockService to prevent duplicates.
 *
 * @param {string} [dateStr]  ISO date to use (defaults to today)
 * @returns {string} e.g., "RH-PAY-26-0319-01"
 */
function _generatePaymentId(dateStr) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(5000);
    var d = dateStr ? new Date(dateStr + 'T12:00:00') : new Date();
    var yy = String(d.getFullYear()).slice(-2);
    var mm = String(d.getMonth() + 1).padStart(2, '0');
    var dd = String(d.getDate()).padStart(2, '0');
    var prefix = 'RH-PAY-' + yy + '-' + mm + dd;

    var props = PropertiesService.getScriptProperties();
    var lastKey = '_lastPaymentId';
    var last = props.getProperty(lastKey) || '';
    var seq = 1;

    if (last.indexOf(prefix) === 0) {
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

// NOTE: processPaymentReceipt() removed — both expense and payment uploads
// now use processReceiptStaged() in ReceiptService.js, which uploads to a
// staging folder. Files are moved to their final folder at submit time via
// _moveReceiptToFinalFolder().
