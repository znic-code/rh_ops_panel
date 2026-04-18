// ── QUOTE GENERATION ─────────────────────────────────────────
// Mirrors InvoiceService.js but uses the Quote template.
//
// Template: Template - Quote (CONFIG.QUOTE_TEMPLATE_ID)
// Placeholders:
//   {{QUOTE_ID}}, {{QUOTE_ISSUE_DATE}}, {{QUOTE_VALID_DATE}}
//   {{CLIENT_LEGAL_NAME}}, {{CLIENT_ADDRESS}}, {{CLIENT_PHONE}},
//   {{CLIENT_EMAIL}}, {{CLIENT_WEBSITE}}
//   {{LINE_ITEM_NAME}}, {{LINE_ITEM_DESCRIPTION}},
//   {{LINE_ITEM_QTY}}, {{LINE_ITEM_UNIT_PRICE}}, {{LINE_ITEM_TOTAL}}
//   {{QUOTE_SUBTOTAL}}, {{QUOTE_TAXES}}, {{QUOTE_TOTAL}}
//
// Saved to: 03_Clients/{Client}/Quotes/{year}/

function generateQuote(data) {
  try {
    var quoteId = getNextQuoteId();

    // Resolve the client's Quotes folder
    var folderId = resolveClientQuotesFolder(data.driveFolderId);
    if (!folderId) folderId = CONFIG.CLIENTS_DRIVE_ROOT;

    // Year subfolder (e.g., Quotes/2026/)
    var yearFolderId = resolveOrCreateSubfolder(folderId, new Date().getFullYear().toString());
    if (yearFolderId) folderId = yearFolderId;

    // Copy template via Drive API (avoids carrying bound scripts)
    var copied = Drive.Files.copy(
      { name: 'Quote ' + quoteId, parents: [folderId] },
      CONFIG.QUOTE_TEMPLATE_ID
    );

    var driveUrl, fileId;
    try {
      var doc  = DocumentApp.openById(copied.id);
      var body = doc.getBody();

      // ── Step 1: Replace scalar placeholders ──────────────────
      var clientAddress = formatBillingAddress(data);
      var replacements = {
        '{{QUOTE_ID}}':          quoteId,
        '{{QUOTE_ISSUE_DATE}}':  data.issueDate,
        '{{QUOTE_VALID_DATE}}':  data.validDate,
        '{{CLIENT_LEGAL_NAME}}': data.clientName,
        '{{CLIENT_ADDRESS}}':    clientAddress,
        '{{CLIENT_PHONE}}':      data.clientPhone   || '',
        '{{CLIENT_EMAIL}}':      data.clientEmail   || '',
        '{{CLIENT_WEBSITE}}':    data.clientWebsite || '',
        '{{QUOTE_SUBTOTAL}}':    formatCurrency(data.subtotal),
        '{{QUOTE_TAXES}}':       formatCurrency(data.taxes),
        '{{QUOTE_TOTAL}}':       formatCurrency(data.total),
      };
      for (var find in replacements) {
        body.replaceText(escapeRegex(find), replacements[find]);
      }

      // ── Step 2: Remove blank optional client rows ────────────
      var tables = body.getTables();
      removeBlankClientRows(tables[0]);

      // ── Step 3: Fill line items (Table 1) ────────────────────
      var lineTable = tables[1];

      // Center header row numeric columns (QTY, PRICE, TOTAL)
      var headerRow = lineTable.getRow(0);
      for (var h = 1; h <= 3; h++) {
        headerRow.getCell(h).getChild(0).asParagraph()
          .setAlignment(DocumentApp.HorizontalAlignment.CENTER);
      }

      // Remove spacer row before filling items
      lineTable.removeRow(lineTable.getNumRows() - 1);

      // Clear template row description cell to strip glyph formatting
      lineTable.getRow(1).getCell(0).clear();

      // Fill item 1 into the existing template row
      fillLineItemRow(lineTable, 1, data.lineItems[0]);

      // Append rows for items 2+
      for (var i = 1; i < data.lineItems.length; i++) {
        var newRow = lineTable.appendTableRow();
        while (newRow.getNumCells() < 4) newRow.appendTableCell('');
        fillLineItemRow(lineTable, lineTable.getNumRows() - 1, data.lineItems[i]);
      }

      // Re-add spacer row at the bottom
      var spacer = lineTable.appendTableRow();
      while (spacer.getNumCells() < 4) spacer.appendTableCell('');

      // ── Step 4: Center totals table values (Table 2) ─────────
      var totalsTable = tables[2];
      for (var t = 0; t < totalsTable.getNumRows(); t++) {
        var tRow = totalsTable.getRow(t);
        var lastCell = tRow.getCell(tRow.getNumCells() - 1);
        lastCell.getChild(0).asParagraph()
          .setAlignment(DocumentApp.HorizontalAlignment.CENTER);
      }

      doc.saveAndClose();

      // ── Step 5: Export as PDF ─────────────────────────────────
      var pdfBlob = DriveApp.getFileById(copied.id)
        .getAs('application/pdf')
        .setName('Quote ' + quoteId + '.pdf');
      var pdfFile = DriveApp.getFolderById(folderId).createFile(pdfBlob);
      // Trash the temporary Google Doc copy
      DriveApp.getFileById(copied.id).setTrashed(true);
      driveUrl = pdfFile.getUrl();
      fileId   = pdfFile.getId();

    } catch (innerErr) {
      try { DriveApp.getFileById(copied.id).setTrashed(true); } catch (_) {}
      throw innerErr;
    }

    // ── Step 6: Log to Notion (isolated, non-fatal) ──────────
    var notionError = null;
    var quotePageId = null;
    if (data.logToNotion) {
      try {
        var notionResult = logQuoteToNotion(quoteId, data, driveUrl);
        if (notionResult && notionResult.success) {
          quotePageId = notionResult.pageId;
        } else {
          notionError = (notionResult && notionResult.error) || 'Unknown Notion error';
        }
      } catch (notionErr) {
        notionError = notionErr.message;
      }
    }

    var result = { success: true, quoteId: quoteId, url: driveUrl, fileId: fileId, pageId: quotePageId };
    if (notionError) result.notionError = notionError;
    return result;
  } catch (e) {
    return { success: false, error: e.message + '\n' + e.stack };
  }
}

/**
 * Regenerate the PDF for an existing quote (edit flow).
 * Uses the existing quoteId — does not create a new Notion page.
 * @param {Object} data - Same shape as generateQuote data, must include quoteId.
 * @returns {{ success, driveUrl, fileId } | { success: false, error }}
 */
function regenerateQuotePdf(data) {
  try {
    var quoteId = data.quoteId;

    var folderId = resolveClientQuotesFolder(data.driveFolderId);
    if (!folderId) folderId = CONFIG.CLIENTS_DRIVE_ROOT;

    var yearFolderId = resolveOrCreateSubfolder(folderId, new Date().getFullYear().toString());
    if (yearFolderId) folderId = yearFolderId;

    var copied = Drive.Files.copy(
      { name: 'Quote ' + quoteId, parents: [folderId] },
      CONFIG.QUOTE_TEMPLATE_ID
    );

    var driveUrl, fileId;
    try {
      var doc  = DocumentApp.openById(copied.id);
      var body = doc.getBody();

      var clientAddress = formatBillingAddress(data);
      var replacements = {
        '{{QUOTE_ID}}':          quoteId,
        '{{QUOTE_ISSUE_DATE}}':  data.issueDate,
        '{{QUOTE_VALID_DATE}}':  data.validDate,
        '{{CLIENT_LEGAL_NAME}}': data.clientName,
        '{{CLIENT_ADDRESS}}':    clientAddress,
        '{{CLIENT_PHONE}}':      data.clientPhone   || '',
        '{{CLIENT_EMAIL}}':      data.clientEmail   || '',
        '{{CLIENT_WEBSITE}}':    data.clientWebsite || '',
        '{{QUOTE_SUBTOTAL}}':    formatCurrency(data.subtotal),
        '{{QUOTE_TAXES}}':       formatCurrency(data.taxes),
        '{{QUOTE_TOTAL}}':       formatCurrency(data.total),
      };
      for (var find in replacements) {
        body.replaceText(escapeRegex(find), replacements[find]);
      }

      var tables = body.getTables();
      removeBlankClientRows(tables[0]);

      var lineTable = tables[1];
      var headerRow = lineTable.getRow(0);
      for (var h = 1; h <= 3; h++) {
        headerRow.getCell(h).getChild(0).asParagraph()
          .setAlignment(DocumentApp.HorizontalAlignment.CENTER);
      }
      lineTable.removeRow(lineTable.getNumRows() - 1);
      lineTable.getRow(1).getCell(0).clear();
      fillLineItemRow(lineTable, 1, data.lineItems[0]);
      for (var i = 1; i < data.lineItems.length; i++) {
        var newRow = lineTable.appendTableRow();
        while (newRow.getNumCells() < 4) newRow.appendTableCell('');
        fillLineItemRow(lineTable, lineTable.getNumRows() - 1, data.lineItems[i]);
      }
      var spacer = lineTable.appendTableRow();
      while (spacer.getNumCells() < 4) spacer.appendTableCell('');

      var totalsTable = tables[2];
      for (var t = 0; t < totalsTable.getNumRows(); t++) {
        var tRow = totalsTable.getRow(t);
        var lastCell = tRow.getCell(tRow.getNumCells() - 1);
        lastCell.getChild(0).asParagraph()
          .setAlignment(DocumentApp.HorizontalAlignment.CENTER);
      }

      doc.saveAndClose();

      var pdfBlob = DriveApp.getFileById(copied.id)
        .getAs('application/pdf')
        .setName('Quote ' + quoteId + '.pdf');
      var pdfFile = DriveApp.getFolderById(folderId).createFile(pdfBlob);
      DriveApp.getFileById(copied.id).setTrashed(true);
      driveUrl = pdfFile.getUrl();
      fileId   = pdfFile.getId();

    } catch (innerErr) {
      try { DriveApp.getFileById(copied.id).setTrashed(true); } catch (_) {}
      throw innerErr;
    }

    return { success: true, driveUrl: driveUrl, fileId: fileId };
  } catch (e) {
    return { success: false, error: e.message + '\n' + e.stack };
  }
}

/**
 * Generate a sequential quote ID for today: RH-QT-YY-MMDD-NN
 * Uses LockService to prevent duplicate IDs under concurrent requests.
 */
function getNextQuoteId() {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var now = new Date();
    var yy = String(now.getFullYear()).slice(-2);
    var mm = String(now.getMonth() + 1).padStart(2, '0');
    var dd = String(now.getDate()).padStart(2, '0');
    var prefix = 'RH-QTE-' + yy + '-' + mm + dd;

    var props = PropertiesService.getScriptProperties();
    var lastKey = '_lastQuoteId';
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
