// ── INVOICE GENERATION ───────────────────────────────────────
// Core function shared by both the sidebar and the web app.
//
// How it works:
//   1. Copy the Invoice v2 template (via Drive API to avoid copying the bound script)
//   2. Replace scalar placeholders ({{INVOICE_ID}}, {{CLIENT_LEGAL_NAME}}, etc.)
//   3. Remove blank optional client rows (phone, email, website if empty)
//   4. Fill line items into the table (template row for item 1, appended rows for 2+)
//   5. Center numeric columns and totals
//   6. Export as PDF (default) or keep as Google Doc
//   7. Optionally log to Notion Invoices database
//
// Template structure (3 tables):
//   Table 0 — Client info (rows 0-3: company info, rows 4+: optional fields)
//   Table 1 — Line items  (row 0: header, row 1: template row, row 2: spacer)
//   Table 2 — Totals      (subtotal, taxes, total)

function generateInvoice(data) {
  try {
    var invoiceId = getNextInvoiceId();

    // Resolve the client's Invoices folder: direct ID lookup → name search → root fallback.
    // resolveClientInvoicesFolder() handles invalid IDs gracefully (returns null).
    var folderId = resolveClientInvoicesFolder(data.driveFolderId);
    if (!folderId) folderId = getClientInvoicesFolder(data.clientName);
    if (!folderId) folderId = CONFIG.CLIENTS_DRIVE_ROOT;

    // Organize into year subfolder (e.g., Invoices/2026/)
    var yearFolderId = resolveOrCreateSubfolder(folderId, new Date().getFullYear().toString());
    if (yearFolderId) folderId = yearFolderId;

    // Copy via Drive API (not DriveApp.makeCopy) to avoid carrying the bound script
    var copied = Drive.Files.copy(
      { name: 'Invoice ' + invoiceId, parents: [folderId] },
      CONFIG.TEMPLATE_ID
    );

    // Inner try: if anything below fails, trash the orphaned copy
    var driveUrl, fileId;
    try {
      var doc  = DocumentApp.openById(copied.id);
      var body = doc.getBody();

      // ── Step 1: Replace scalar placeholders ──────────────────
      var clientAddress = formatBillingAddress(data);
      var replacements = {
        '{{INVOICE_ID}}':         invoiceId,
        '{{INVOICE_ISSUE_DATE}}': data.issueDate,
        '{{INVOICE_DUE_DATE}}':   data.dueDate,
        '{{CLIENT_LEGAL_NAME}}':  data.clientName,
        '{{CLIENT_ADDRESS}}':     clientAddress,
        '{{CLIENT_PHONE}}':       data.clientPhone   || '',
        '{{CLIENT_EMAIL}}':       data.clientEmail   || '',
        '{{CLIENT_WEBSITE}}':     data.clientWebsite || '',
        '{{INVOICE_SUBTOTAL}}':   formatCurrency(data.subtotal),
        '{{INVOICE_TAXES}}':      formatCurrency(data.taxes),
        '{{INVOICE_TOTAL}}':      formatCurrency(data.total),
      };
      for (var find in replacements) {
        body.replaceText(escapeRegex(find), replacements[find]);
      }

      // ── Step 2: Remove blank optional client rows ────────────
      var tables = body.getTables();
      removeBlankClientRows(tables[0]);

      // ── Step 3: Fill line items (Table 1) ────────────────────
      //    Row 0 = header, Row 1 = template row (has placeholders), last row = spacer
      var lineTable = tables[1];

      // Center the header row numeric columns (QTY, PRICE, TOTAL)
      var headerRow = lineTable.getRow(0);
      for (var h = 1; h <= 3; h++) {
        headerRow.getCell(h).getChild(0).asParagraph()
          .setAlignment(DocumentApp.HorizontalAlignment.CENTER);
      }

      // Remove the spacer row (last row) — we'll re-add it after all items
      lineTable.removeRow(lineTable.getNumRows() - 1);

      // Clear template row's description cell to strip inherited ListItem glyph formatting.
      // Without this, item 1 shows a circle bullet (○) before the name.
      lineTable.getRow(1).getCell(0).clear();

      // Fill item 1 into the existing template row
      fillLineItemRow(lineTable, 1, data.lineItems[0]);

      // Append new rows for items 2+
      for (var i = 1; i < data.lineItems.length; i++) {
        var newRow = lineTable.appendTableRow();
        while (newRow.getNumCells() < 4) {
          newRow.appendTableCell('');
        }
        fillLineItemRow(lineTable, lineTable.getNumRows() - 1, data.lineItems[i]);
      }

      // Re-add spacer row at the bottom of the line items table
      var spacer = lineTable.appendTableRow();
      while (spacer.getNumCells() < 4) {
        spacer.appendTableCell('');
      }

      // ── Step 4: Center totals table values (Table 2) ─────────
      var totalsTable = tables[2];
      for (var t = 0; t < totalsTable.getNumRows(); t++) {
        var tRow = totalsTable.getRow(t);
        var lastCell = tRow.getCell(tRow.getNumCells() - 1);
        lastCell.getChild(0).asParagraph()
          .setAlignment(DocumentApp.HorizontalAlignment.CENTER);
      }

      doc.saveAndClose();

      // ── Step 5: Export as PDF or keep as Google Doc ───────────
      if (data.exportPdf) {
        var pdfBlob = DriveApp.getFileById(copied.id)
          .getAs('application/pdf')
          .setName('Invoice ' + invoiceId + '.pdf');
        var pdfFile = DriveApp.getFolderById(folderId).createFile(pdfBlob);
        // Trash the temporary Google Doc copy (PDF is the final deliverable)
        DriveApp.getFileById(copied.id).setTrashed(true);
        driveUrl = pdfFile.getUrl();
        fileId   = pdfFile.getId();
      } else {
        driveUrl = 'https://docs.google.com/document/d/' + copied.id + '/edit';
        fileId   = copied.id;
      }
    } catch (innerErr) {
      // Trash the orphaned Drive copy before re-throwing
      try { DriveApp.getFileById(copied.id).setTrashed(true); } catch (_) {}
      throw innerErr;
    }

    // ── Step 6: Log to Notion (isolated, non-fatal) ──────────
    var notionError = null;
    var invoicePageId = null;
    if (data.logToNotion) {
      try {
        var notionResult = logToNotion(invoiceId, data, driveUrl);
        if (notionResult && notionResult.success) {
          invoicePageId = notionResult.pageId;
        } else {
          notionError = (notionResult && notionResult.error) || 'Unknown Notion error';
        }
      } catch (notionErr) {
        notionError = notionErr.message;
      }
    }

    // ── Step 7: Mark imported billable expenses as invoiced ──
    if (invoicePageId && data.importedExpenseIds && data.importedExpenseIds.length) {
      try {
        markExpensesAsInvoiced(data.importedExpenseIds, invoicePageId);
      } catch (markErr) {
        Logger.log('markExpensesAsInvoiced error: ' + markErr.message);
      }
    }

    var result = { success: true, invoiceId: invoiceId, url: driveUrl, fileId: fileId };
    if (invoicePageId) result.pageId = invoicePageId;
    if (notionError) result.notionError = notionError;
    return result;
  } catch (e) {
    return { success: false, error: e.message + '\n' + e.stack };
  }
}

/**
 * Fill a single line item row in the line items table.
 *
 * Cell layout: [Description | QTY | Unit Price | Total]
 *
 * Description cell (col 0):
 *   Bold item name on the first line, followed by description lines
 *   prefixed with Unicode bullet "•". Uses editAsText() for safe
 *   text manipulation (appendParagraph + setGlyphType causes silent errors).
 *
 * Numeric cells (cols 1-3):
 *   Plain text, horizontally centered.
 */
function fillLineItemRow(table, rowIndex, item) {
  const row = table.getRow(rowIndex);

  // ── Numeric cells (cols 1-3) — centered ─────────────────────
  const total = formatCurrency(item.qty * item.price);
  var numCells = [
    { cell: row.getCell(1), val: String(item.qty) },
    { cell: row.getCell(2), val: '$' + formatCurrency(item.price) },
    { cell: row.getCell(3), val: '$' + total },
  ];
  numCells.forEach(function(c) {
    c.cell.editAsText().setText(c.val);
    c.cell.getChild(0).asParagraph().setAlignment(DocumentApp.HorizontalAlignment.CENTER);
  });

  // ── Description cell (col 0) ──────────────────────────────
  // Build full text: "Item Name\n• line1\n• line2"
  var desc = item.name;
  if (item.description && item.description.trim() !== '') {
    var lines = item.description.split('\n').filter(function(l) { return l.trim() !== ''; });
    lines.forEach(function(line) {
      desc += '\n• ' + line.trim();
    });
  }
  var text = row.getCell(0).editAsText();
  text.setText(desc);
  // Un-bold everything first, then bold just the item name
  text.setBold(0, desc.length - 1, false);
  text.setBold(0, item.name.length - 1, true);
}

/**
 * Remove client table rows where the value cell is empty after
 * placeholder replacement. This hides optional fields (phone, email,
 * website) when the client doesn't have them.
 * Walks backwards to avoid index shifting when removing rows.
 */
function removeBlankClientRows(table) {
  const CLIENT_SECTION_START = 4;
  for (let r = table.getNumRows() - 1; r >= CLIENT_SECTION_START; r--) {
    if (table.getRow(r).getCell(0).getText().trim() === '') {
      table.removeRow(r);
    }
  }
}

/**
 * Build a single-line billing address from individual fields.
 * Omits country for US/USA. Example: "300 Calle..., San Juan, PR 00918"
 */
function formatBillingAddress(data) {
  const parts = [];
  if (data.clientStreet) parts.push(data.clientStreet);
  const cityState = [data.clientCity, data.clientState].filter(Boolean).join(', ');
  const cityStateZip = data.clientZip ? cityState + ' ' + data.clientZip : cityState;
  if (cityStateZip) parts.push(cityStateZip);
  const country = data.clientCountry || '';
  if (country && country.toUpperCase() !== 'US' && country.toUpperCase() !== 'USA') {
    parts.push(country);
  }
  return parts.join(', ');
}

/**
 * Find the client's Invoices folder on Drive (fallback when driveFolderId is missing).
 * Searches the Clients root folder for a subfolder whose name matches
 * the full client name (case-insensitive), then looks for an "Invoices" subfolder inside it.
 * Returns the folder ID, or null if no match is found.
 */
function getClientInvoicesFolder(clientName) {
  if (!clientName) return null;
  const root = DriveApp.getFolderById(CONFIG.CLIENTS_DRIVE_ROOT);
  const target = clientName.toLowerCase().trim();
  const folders = root.getFolders();
  while (folders.hasNext()) {
    const f = folders.next();
    if (f.getName().toLowerCase().trim() === target) {
      const sub = f.getFoldersByName('Invoices');
      if (sub.hasNext()) return sub.next().getId();
      return f.getId();
    }
  }
  return null;
}

/**
 * Generate a sequential invoice ID for today: RH-INV-YY-MMDD-NN
 * Scans Drive for existing files with today's prefix and increments.
 *
 * Uses LockService to prevent duplicate IDs when two requests
 * (e.g., sidebar + API call) fire at the same time.
 */
function getNextInvoiceId() {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000); // wait up to 15 s for any competing request
  try {
    const now = new Date();
    const yy = String(now.getFullYear()).slice(-2);
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const prefix = 'RH-INV-' + yy + '-' + mm + dd;

    var props = PropertiesService.getScriptProperties();
    var lastKey = '_lastInvoiceId';
    var last = props.getProperty(lastKey) || '';
    var seq = 1;

    if (last.indexOf(prefix) === 0) {
      var lastSeq = parseInt(last.split('-').pop(), 10);
      if (!isNaN(lastSeq)) seq = lastSeq + 1;
    }

    var newId = prefix + '-' + String(seq).padStart(2, '0');
    props.setProperty(lastKey, newId);
    return newId;
  } finally {
    lock.releaseLock();
  }
}
