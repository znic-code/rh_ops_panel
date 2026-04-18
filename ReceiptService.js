// ── RECEIPT SERVICE ──────────────────────────────────────────
// AI-powered receipt extraction using Claude (Anthropic API).
// Extracts structured expense data from receipt images and PDFs.

/**
 * Extract expense data from a receipt file using Claude Vision.
 * Sends the image/PDF to Claude Haiku and returns structured JSON.
 *
 * @param {string} fileId  Drive file ID of the uploaded receipt
 * @returns {{ success: boolean, data?: Object, error?: string }}
 *
 * Returned data shape:
 *   { vendor, description, amount, date, category, lineItems[], taxAmount, currency, notes }
 */
/**
 * Extract structured data from a receipt/document image.
 *
 * @param {string} fileId   Drive file ID
 * @param {string} [context='expense']  'expense' or 'payment' — determines the extraction prompt
 * @returns {{ success, data?, error? }}
 */
function extractReceiptData(fileId, context) {
  try {
    var fileInfo = getFileAsBase64(fileId);
    var mimeType = fileInfo.mimeType;

    // Convert HEIC/HEIF to JPEG via Drive thumbnail API (iPhone camera format)
    // GAS blob.getAs() doesn't support HEIC natively — must use thumbnail workaround
    if (mimeType === 'image/heic' || mimeType === 'image/heif') {
      Logger.log('extractReceiptData: converting ' + mimeType + ' to JPEG via thumbnail API');
      try {
        var thumbUrl = 'https://drive.google.com/thumbnail?id=' + fileId + '&sz=w2048';
        var thumbBlob = UrlFetchApp.fetch(thumbUrl, {
          headers: { authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
          muteHttpExceptions: true,
        }).getBlob().getAs('image/jpeg');
        fileInfo.base64 = Utilities.base64Encode(thumbBlob.getBytes());
        mimeType = 'image/jpeg';
        Logger.log('extractReceiptData: HEIC conversion successful, JPEG size=' + fileInfo.base64.length);
      } catch (convErr) {
        Logger.log('extractReceiptData: HEIC conversion failed — ' + convErr.message);
        return { success: false, error: 'Could not convert HEIC image. Try taking the photo with Camera set to "Most Compatible" format, or convert to JPEG first.' };
      }
    }

    // Validate file type
    var supported = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];
    if (supported.indexOf(mimeType) === -1) {
      return { success: false, error: 'Unsupported file type: ' + mimeType + '. Use JPEG, PNG, WebP, GIF, or PDF.' };
    }

    var extracted = _callClaudeVision(fileInfo.base64, mimeType, context || 'expense');

    if (!extracted || extracted.error) {
      return { success: false, error: extracted ? extracted.error : 'No response from Claude.' };
    }

    // Suggest category based on vendor/description if AI didn't assign one (expenses only)
    if ((context || 'expense') === 'expense' && !extracted.category) {
      extracted.category = _suggestCategory(extracted.vendor, extracted.description);
    }

    return { success: true, data: extracted };
  } catch (e) {
    Logger.log('extractReceiptData error: ' + e.message);
    return { success: false, error: 'Extraction failed: ' + e.message };
  }
}

/**
 * Call Claude Vision API with a receipt/document image.
 * Uses claude-sonnet-4-20250514 for receipt extraction.
 *
 * @param {string} base64Data  Base64-encoded image/PDF data
 * @param {string} mimeType    MIME type of the file
 * @param {string} context     'expense' or 'payment'
 * @returns {Object} Parsed receipt data or { error: string }
 */
function _callClaudeVision(base64Data, mimeType, context) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!apiKey) {
    return { error: 'ANTHROPIC_API_KEY not set in Script Properties.' };
  }

  var url = 'https://api.anthropic.com/v1/messages';

  // Build content parts based on file type
  var imagePart;
  if (mimeType === 'application/pdf') {
    imagePart = {
      type: 'document',
      source: { type: 'base64', media_type: mimeType, data: base64Data }
    };
  } else {
    imagePart = {
      type: 'image',
      source: { type: 'base64', media_type: mimeType, data: base64Data }
    };
  }

  // ── Context-specific prompts ─────────────────────────────
  var prompt;

  if (context === 'payment') {
    prompt = 'Extract payment data from this document. Return ONLY valid JSON with this exact structure:\n'
      + '{\n'
      + '  "vendor": "Who was paid / payer name",\n'
      + '  "description": "Brief description of the payment (2-8 words)",\n'
      + '  "amount": 0.00,\n'
      + '  "date": "YYYY-MM-DD",\n'
      + '  "currency": "USD",\n'
      + '  "method": null,\n'
      + '  "referenceNumber": null,\n'
      + '  "invoiceNumber": null,\n'
      + '  "notes": "Any other relevant info (memo, account details, etc.)"\n'
      + '}\n\n'
      + 'Rules:\n'
      + '- "amount" is the total payment amount\n'
      + '- Use numbers for amounts, not strings\n'
      + '- Use null for fields not visible on the document\n'
      + '- "method" must be one of: Check, ACH, Wire, Zelle, Card, Other — or null if unclear\n'
      + '- "referenceNumber" is a check number, confirmation number, transaction ID, or similar\n'
      + '- "invoiceNumber" is the invoice number if referenced on the document\n'
      + '- Return ONLY the JSON object, no other text';
  } else {
    prompt = 'Extract expense data from this receipt. Return ONLY valid JSON with this exact structure:\n'
      + '{\n'
      + '  "vendor": "Business/store name",\n'
      + '  "description": "Brief description of the purchase (2-8 words)",\n'
      + '  "amount": 0.00,\n'
      + '  "taxAmount": 0.00,\n'
      + '  "subtotal": 0.00,\n'
      + '  "date": "YYYY-MM-DD",\n'
      + '  "currency": "USD",\n'
      + '  "category": null,\n'
      + '  "lineItems": [\n'
      + '    { "description": "Item name", "quantity": 1, "amount": 0.00 }\n'
      + '  ],\n'
      + '  "notes": "Any other relevant info (payment method, order number, etc.)"\n'
      + '}\n\n'
      + 'Rules:\n'
      + '- "amount" is the final total (including tax)\n'
      + '- Use numbers for amounts, not strings\n'
      + '- Use null for fields not visible on the receipt\n'
      + '- "category" must be one of: Contractor Payments, Equipment, Software & Subscriptions, Travel & Meals, Professional Services, Marketing & Advertising, Operations — or null if unclear\n'
      + '- Return ONLY the JSON object, no other text';
  }

  var payload = {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: [
        imagePart,
        { type: 'text', text: prompt }
      ]
    }]
  };

  var options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  var response = UrlFetchApp.fetch(url, options);
  var code = response.getResponseCode();

  if (code !== 200) {
    var errBody = response.getContentText();
    Logger.log('Claude API error ' + code + ': ' + errBody);
    // Parse error message if possible
    try {
      var errJson = JSON.parse(errBody);
      return { error: 'Claude API error: ' + (errJson.error.message || errBody) };
    } catch (e) {
      return { error: 'Claude API returned status ' + code };
    }
  }

  var body = JSON.parse(response.getContentText());

  // Extract text from Claude response
  var text = '';
  try {
    for (var i = 0; i < body.content.length; i++) {
      if (body.content[i].type === 'text') {
        text = body.content[i].text;
        break;
      }
    }
  } catch (e) {
    return { error: 'Unexpected Claude response format.' };
  }

  if (!text) {
    return { error: 'Empty response from Claude.' };
  }

  // Clean up response — strip markdown code fences if present
  text = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();

  try {
    var parsed = JSON.parse(text);
    // Ensure amounts are numbers
    if (parsed.amount && typeof parsed.amount === 'string') {
      parsed.amount = parseFloat(parsed.amount.replace(/[^0-9.\-]/g, '')) || 0;
    }
    if (parsed.taxAmount && typeof parsed.taxAmount === 'string') {
      parsed.taxAmount = parseFloat(parsed.taxAmount.replace(/[^0-9.\-]/g, '')) || 0;
    }
    if (parsed.subtotal && typeof parsed.subtotal === 'string') {
      parsed.subtotal = parseFloat(parsed.subtotal.replace(/[^0-9.\-]/g, '')) || 0;
    }
    return parsed;
  } catch (e) {
    Logger.log('Claude JSON parse error. Raw text: ' + text);
    return { error: 'Could not parse Claude response as JSON.' };
  }
}

/**
 * Suggest an expense category based on vendor name and description.
 * Simple keyword matching as a fallback when AI doesn't assign one.
 *
 * @param {string} vendor
 * @param {string} description
 * @returns {string} Category name
 */
function _suggestCategory(vendor, description) {
  var text = ((vendor || '') + ' ' + (description || '')).toLowerCase();

  // Software & Subscriptions
  if (/adobe|google|microsoft|apple|aws|amazon web|dropbox|slack|notion|figma|canva|zoom|vimeo|openai|anthropic|github|netlify|vercel|saas|subscription|software|license/i.test(text)) {
    return 'Software & Subscriptions';
  }
  // Equipment
  if (/camera|lens|tripod|light|mic|audio|monitor|hard drive|ssd|memory card|battery|drone|gimbal|rig|equipment|gear|b&h|adorama|best buy/i.test(text)) {
    return 'Equipment';
  }
  // Travel & Meals
  if (/uber|lyft|taxi|airline|flight|hotel|airbnb|gas|fuel|parking|toll|rental car|mileage|travel|restaurant|food|meal|catering/i.test(text)) {
    return 'Travel & Meals';
  }
  // Contractor Payments
  if (/contractor|freelance|talent|actor|model|crew|editor|photographer|videographer/i.test(text)) {
    return 'Contractor Payments';
  }
  // Professional Services
  if (/attorney|lawyer|accountant|cpa|consultant|legal|accounting|bookkeeping/i.test(text)) {
    return 'Professional Services';
  }
  // Marketing & Advertising
  if (/advertising|marketing|ads|facebook|instagram|google ads|meta|promotion|pr |public relations/i.test(text)) {
    return 'Marketing & Advertising';
  }

  return 'Operations';
}

/**
 * Full receipt processing pipeline:
 *   1. Upload file to Drive (into the correct folder)
 *   2. Extract data via Claude
 *   3. Return extracted data + file URL for user review
 *
 * @param {string} base64Data            Base64-encoded file
 * @param {string} fileName              Original file name
 * @param {string} mimeType              MIME type
 * @param {string|null} clientDriveFolderId  Client's Drive folder (null for overhead)
 * @returns {{ success, fileUrl?, fileId?, extracted?, error? }}
 */
/**
 * Upload receipt to a staging folder and run AI extraction.
 * The file is placed in 01_Admin/Financials/_Staging/ temporarily.
 * At submit time, _moveReceiptToFinalFolder() moves it to the correct location.
 */
function processReceiptStaged(base64Data, fileName, mimeType, context) {
  try {
    // 1. Upload to staging folder
    var stagingId = resolveOrCreateSubfolder(CONFIG.FINANCIALS_DRIVE_DIR, '_Staging');
    if (!stagingId) {
      return { success: false, error: 'Could not resolve or create the staging folder in Drive.' };
    }

    var upload = uploadFileToDrive(base64Data, fileName, mimeType, stagingId);

    // 2. Extract data via AI
    var extraction = extractReceiptData(upload.fileId, context || 'expense');

    return {
      success:         true,
      fileId:          upload.fileId,
      fileUrl:         upload.fileUrl,
      fileName:        upload.fileName,
      staged:          true,
      extracted:       extraction.success ? extraction.data : null,
      extractionError: extraction.success ? null : extraction.error,
    };
  } catch (e) {
    Logger.log('processReceiptStaged error: ' + e.message);
    return { success: false, error: 'Receipt processing failed: ' + e.message };
  }
}

/**
 * Move or copy a receipt file to its final folder based on the client and type.
 * Renames the file to match the record ID (e.g., RH-EXP-26-0320-01.pdf).
 *
 * @param {string} fileId          Drive file ID
 * @param {string} clientId        Notion client ID (or empty for no client)
 * @param {string} folderType      'Expenses' or 'Payments'
 * @param {boolean} isPickerSource true if file was picked from Drive (copy), false if staged (move)
 * @param {string} [recordId]      Optional record ID to rename the file (e.g., RH-EXP-26-0320-01)
 * @returns {{ fileId: string, fileUrl: string }} The final file's ID and URL
 */
function _moveReceiptToFinalFolder(fileId, clientId, folderType, isPickerSource, recordId) {
  // Resolve the correct destination folder
  var clientDriveFolderId = null;
  if (clientId) {
    var client = getClientById(clientId);
    if (client && client.driveFolderId) {
      clientDriveFolderId = client.driveFolderId;
    }
  }

  var folderId;
  if (folderType === 'Payments') {
    folderId = resolvePaymentFolder(clientDriveFolderId, null);
  } else {
    folderId = resolveExpenseFolder(clientDriveFolderId, null);
  }

  if (!folderId) {
    throw new Error('Could not resolve or create the ' + folderType + ' folder in Drive.');
  }

  var targetFolder = DriveApp.getFolderById(folderId);
  var originalFile = DriveApp.getFileById(fileId);

  // Build final filename: RecordID.ext (e.g., RH-EXP-26-0320-01.pdf)
  var finalName = originalFile.getName();
  if (recordId) {
    var ext = finalName.split('.').pop() || 'pdf';
    finalName = recordId + '.' + ext.toLowerCase();
  }

  if (isPickerSource) {
    // Picker file: copy to final folder (leave original in place)
    var copy = originalFile.makeCopy(finalName, targetFolder);
    return { fileId: copy.getId(), fileUrl: copy.getUrl() };
  } else {
    // Staged upload: move to final folder and rename
    originalFile.setName(finalName);
    originalFile.moveTo(targetFolder);
    return { fileId: fileId, fileUrl: originalFile.getUrl() };
  }
}
