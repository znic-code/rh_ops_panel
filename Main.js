// ============================================================
// Road Hazards — Ops Backend
// Google Apps Script — standalone project
//
// Entry points:
//   1. doGet()  — serves the Ops Panel (panel.html) as a standalone web app
//   2. doPost() — JSON API router for all operations
//   3. onOpen() — adds menu to Invoice v2 template (sidebar entry point)
//
// The Ops Panel UI calls server functions directly via google.script.run.
// The doPost() API is for external tools (Claude, curl, automations).
// ============================================================

// ── CACHE HELPERS ────────────────────────────────────────────
//
// Uses CacheService (100KB per key limit). Payloads exceeding the
// chunk size are automatically split across numbered keys and
// reassembled on read. If any chunk is evicted, the read returns
// null (graceful cache miss) and the caller regenerates the data.

var _CACHE_TTL = 300;           // 5 minutes
var _CACHE_CHUNK_SIZE = 90000;  // 90KB per chunk (margin below 100KB GAS limit)
var _CACHE_KEYS = ['dashboard', 'financialReport', 'clients', 'projects', 'contractors'];

/** Retrieve a cached value (handles both single-key and chunked payloads). */
function _cacheGet(key) {
  try {
    var cache = CacheService.getScriptCache();

    // Fast path: single-key read
    var raw = cache.get(key);
    if (raw) return JSON.parse(raw);

    // Check for chunked data
    var metaRaw = cache.get(key + '_chunks');
    if (!metaRaw) return null;

    var meta = JSON.parse(metaRaw);
    var assembled = '';
    for (var i = 0; i < meta.count; i++) {
      var chunk = cache.get(key + '_' + i);
      if (chunk === null) {
        Logger.log('Cache chunk miss (' + key + '_' + i + ')');
        return null; // partial loss → treat as cache miss
      }
      assembled += chunk;
    }
    return JSON.parse(assembled);
  } catch (e) {
    Logger.log('Cache get error (' + key + '): ' + e.message);
    return null;
  }
}

/** Store a value in cache, auto-chunking if it exceeds _CACHE_CHUNK_SIZE. */
function _cacheSet(key, value, ttl) {
  try {
    var json = JSON.stringify(value);
    var cache = CacheService.getScriptCache();
    var effectiveTtl = ttl || _CACHE_TTL;

    if (json.length <= _CACHE_CHUNK_SIZE) {
      // Single key (most common case)
      cache.put(key, json, effectiveTtl);
      cache.remove(key + '_chunks'); // clean up any leftover chunk metadata
      return;
    }

    // Multi-chunk: split payload across numbered keys
    var chunks = [];
    for (var i = 0; i < json.length; i += _CACHE_CHUNK_SIZE) {
      chunks.push(json.substring(i, i + _CACHE_CHUNK_SIZE));
    }

    cache.put(key + '_chunks', JSON.stringify({ count: chunks.length }), effectiveTtl);
    for (var c = 0; c < chunks.length; c++) {
      cache.put(key + '_' + c, chunks[c], effectiveTtl);
    }
    // Remove the single-key entry so _cacheGet doesn't find stale data
    cache.remove(key);

    Logger.log('Cache chunked (' + key + '): ' + chunks.length + ' chunks, ' + json.length + ' bytes');
  } catch (e) {
    Logger.log('Cache set error (' + key + '): ' + e.message);
  }
}

/** Remove cached values including any chunk keys. */
function _cacheInvalidate(keys) {
  try {
    var cache = CacheService.getScriptCache();
    var allKeys = [];
    keys.forEach(function(key) {
      allKeys.push(key);
      allKeys.push(key + '_chunks');
      for (var i = 0; i < 10; i++) allKeys.push(key + '_' + i);
    });
    cache.removeAll(allKeys);
  } catch (e) {
    Logger.log('Cache invalidate error: ' + e.message);
  }
}

// ── MENU (for Invoice v2 template) ──────────────────────────

function onOpen() {
  try {
    DocumentApp.getUi()
      .createMenu('🧾 Road Hazards')
      .addItem('Generate Invoice…', 'showSidebar')
      .addToUi();
  } catch (e) {
    // Not running inside a Doc — skip menu creation
  }
}

// ── SIDEBAR (Invoice v2 template) ────────────────────────────

function showSidebar() {
  const html = HtmlService.createTemplateFromFile('sidebar')
    .evaluate()
    .setTitle('Generate Invoice')
    .setWidth(360);
  DocumentApp.getUi().showSidebar(html);
}

// ── WEB APP — doGet ──────────────────────────────────────────

function doGet(e) {
  const page = e && e.parameter && e.parameter.page;

  // ── API: return picker data for iOS Shortcuts ───────────
  if (page === 'api') {
    var secret = e.parameter.secret;
    if (secret !== CONFIG.API_SECRET) {
      return _jsonResponse({ success: false, error: 'Invalid secret' });
    }
    var apiAction = e.parameter.action || '';
    switch (apiAction) {
      case 'getPickerData':
        return _jsonResponse(_getShortcutPickerData());
      default:
        return _jsonResponse({ success: false, error: 'Unknown API action: ' + apiAction });
    }
  }

  // If ?page=invoice, serve the original invoice generator webapp
  if (page === 'invoice') {
    var faviconUrlInv = 'https://drive.google.com/uc?id=1ReOAGhNBh5l4abfWLhTfaLEnrYhO9a-V&export=download&format=png';
    return HtmlService.createTemplateFromFile('webapp')
      .evaluate()
      .setTitle('Road Hazards — Invoice Generator')
      .setFaviconUrl(faviconUrlInv)
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  // Default: serve the Ops Panel
  var faviconUrl = 'https://drive.google.com/uc?id=1ReOAGhNBh5l4abfWLhTfaLEnrYhO9a-V&export=download&format=png';
  return HtmlService.createTemplateFromFile('panel')
    .evaluate()
    .setTitle('Road Hazards — Ops Panel')
    .setFaviconUrl(faviconUrl)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ── WEB APP — doPost (JSON API) ──────────────────────────────
// Routes by `action` field. All require `secret` for auth.

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);

    if (body.secret !== CONFIG.API_SECRET) {
      return _jsonResponse({ success: false, error: 'Invalid secret' });
    }

    const action = body.action || 'generateInvoice';

    switch (action) {
      case 'generateInvoice':
        return _handleGenerateInvoice(body);
      case 'createClient':
        return _jsonResponse(createFullClient(body));
      case 'createProject':
        return _jsonResponse(createProject(body));
      case 'createAgreement':
        return _jsonResponse(createAgreement(body));
      case 'logExpense':
        return _jsonResponse(logExpense(body));
      case 'logPayment':
        return _jsonResponse(logPayment(body));
      case 'sendEmail':
        return _jsonResponse(createDocumentDraft(body));

      // ── iOS Shortcut actions ─────────────────────────────
      case 'quickExpense':
        return _jsonResponse(_handleQuickExpense(body));
      case 'quickPayment':
        return _jsonResponse(_handleQuickPayment(body));
      case 'getPickerData':
        return _jsonResponse(_getShortcutPickerData());
      default:
        return _jsonResponse({ success: false, error: 'Unknown action: ' + action });
    }
  } catch (err) {
    return _jsonResponse({ success: false, error: err.message });
  }
}

/** Handle the generateInvoice action (original doPost flow). */
function _handleGenerateInvoice(body) {
  if (!body.clientName || !body.lineItems || !body.lineItems.length) {
    return _jsonResponse({ success: false, error: 'clientName and lineItems are required' });
  }

  const client = lookupClientByName(body.clientName);
  const project = body.projectName ? lookupProjectByName(body.projectName) : null;

  const issueISO = body.issueDate || new Date().toISOString().split('T')[0];
  const dueISO   = body.dueDate   || _addDays(issueISO, 14);
  const issueDateForDoc = _formatDateForDoc(issueISO);
  const dueDateForDoc   = _formatDateForDoc(dueISO);

  const subtotal = body.lineItems.reduce(function(s, i) { return s + (i.qty || 1) * (i.price || 0); }, 0);
  const taxes    = parseFloat(body.tax || 0);

  const data = {
    clientId:      client ? client.id : '',
    clientName:    body.clientName,
    driveFolderId: client ? client.driveFolderId  : '',
    clientStreet:  client ? client.billingStreet   : '',
    clientCity:    client ? client.billingCity      : '',
    clientState:   client ? client.billingState     : '',
    clientZip:     client ? client.billingZip       : '',
    clientCountry: client ? client.billingCountry   : '',
    clientPhone:   client ? client.phone            : '',
    clientEmail:   client ? client.billingEmail     : '',
    clientWebsite: client ? client.website          : '',
    projectId:     project ? project.id : '',
    issueDate:     issueDateForDoc,
    dueDate:       dueDateForDoc,
    issueDateISO:  issueISO,
    dueDateISO:    dueISO,
    invoiceType:   body.invoiceType || 'Final',
    lineItems:     body.lineItems.map(function(i) {
      return { name: i.name, description: i.description || '', qty: i.qty || 1, price: i.price || 0 };
    }),
    subtotal:      subtotal,
    taxes:         taxes,
    total:         subtotal + taxes,
    exportPdf:     body.exportPdf !== undefined ? body.exportPdf : true,
    logToNotion:   body.logToNotion !== undefined ? body.logToNotion : true,
  };

  const result = generateInvoice(data);
  if (result.success) _cacheInvalidate(_CACHE_KEYS);
  return _jsonResponse(result);
}

// ── iOS SHORTCUT HANDLERS ──────────────────────────────────

/**
 * Return picker data for iOS Shortcuts — client list and categories.
 * Called via GET ?page=api&action=getPickerData&secret=... or POST action=getPickerData.
 */
function _getShortcutPickerData() {
  try {
    var clients = getClients();
    var clientList = (clients && !clients.error)
      ? clients.map(function(c) { return { id: c.id, name: c.name }; })
      : [];

    // Sort alphabetically
    clientList.sort(function(a, b) { return a.name.localeCompare(b.name); });

    return {
      success: true,
      clients: clientList,
      clientNames: clientList.map(function(c) { return c.name; }),
      categories: ['Software', 'Equipment', 'Travel', 'Meals', 'Office Supplies', 'Subscriptions',
                   'Contractor', 'Marketing', 'Insurance', 'Utilities', 'Rent', 'Other'],
      paymentMethods: ['Check', 'Zelle', 'ACH', 'Wire', 'Card', 'Other'],
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Handle a quick expense from iOS Shortcut.
 * Accepts base64 receipt image, uploads to staging, extracts via AI, logs to Notion,
 * then moves file to the correct folder.
 *
 * @param {Object} body
 * @param {string} body.image       Base64-encoded receipt image
 * @param {string} body.fileName    Original file name (e.g. "IMG_1234.jpg")
 * @param {string} body.mimeType    MIME type (e.g. "image/jpeg")
 * @param {string} [body.clientId]  Optional Notion client ID
 * @param {string} [body.type]      Expense type override (default: "Operational")
 * @param {string} [body.notes]     Additional notes
 * @returns {{ success, expense?, error? }}
 */
function _handleQuickExpense(body) {
  try {
    if (!body.image) {
      return { success: false, error: 'No image provided.' };
    }

    // 1. Upload to staging and extract (expense context)
    var staged = processReceiptStaged(
      body.image,
      body.fileName || 'receipt.jpg',
      body.mimeType || 'image/jpeg',
      'expense'
    );

    if (!staged.success) {
      return { success: false, error: 'Upload failed: ' + staged.error };
    }

    // 2. Build expense data from AI extraction + user overrides
    var extracted = staged.extracted || {};
    var clientId = body.clientId || '';

    // Resolve client by name if clientId not provided
    if (!clientId && body.clientName) {
      var client = lookupClientByName(body.clientName);
      if (client) clientId = client.id;
    }

    var expenseData = {
      description:   extracted.description || extracted.vendor || 'Expense from Shortcut',
      vendor:        extracted.vendor || '',
      amount:        extracted.amount || 0,
      expenseDate:   extracted.date || new Date().toISOString().split('T')[0],
      category:      extracted.category || 'Other',
      type:          body.type || 'Operational',
      clientId:      clientId,
      projectId:     '',
      contractorId:  '',
      billable:      !!clientId,
      notes:         (body.notes || '') + (staged.extractionError ? '\n[AI extraction partial: ' + staged.extractionError + ']' : ''),
      status:        'Review',
      receiptFileId: staged.fileId,
      pickerSource:  false,
      receiptUrl:    '',
    };

    // 3. Pre-generate ID and move file to correct folder with proper name
    var preGeneratedId = _generateExpenseId(expenseData.expenseDate);
    expenseData.expenseId = preGeneratedId;

    if (staged.fileId) {
      var finalFile = _moveReceiptToFinalFolder(staged.fileId, clientId, 'Expenses', false, preGeneratedId);
      expenseData.receiptUrl = finalFile.fileUrl;
    }

    // 4. Log to Notion
    Logger.log('quickExpense expenseData: status=' + expenseData.status + ', amount=' + expenseData.amount + ', extracted=' + JSON.stringify(extracted).substring(0, 200));
    var result = logExpense(expenseData);
    Logger.log('quickExpense logExpense result: ' + JSON.stringify(result).substring(0, 300));

    if (result.success) {
      _cacheInvalidate(_CACHE_KEYS);
      return {
        success: true,
        expense: result.expense,
        extracted: extracted,
        notionUrl: result.expense.notionUrl || '',
        message: (extracted.vendor ? extracted.vendor + ' — ' : '')
          + '$' + (extracted.amount || 0).toFixed(2)
          + ' (' + (result.expense.expenseId || 'logged') + ')',
      };
    }

    return result;
  } catch (e) {
    Logger.log('_handleQuickExpense error: ' + e.message);
    return { success: false, error: e.message };
  }
}

/**
 * Handle a quick payment from iOS Shortcut.
 * Same pattern as quick expense but for payments.
 *
 * @param {Object} body
 * @param {string} [body.image]      Base64-encoded receipt image (optional)
 * @param {string} [body.fileName]   Original file name
 * @param {string} [body.mimeType]   MIME type
 * @param {string} [body.clientId]   Optional Notion client ID
 * @param {number} [body.amount]     Payment amount (overrides AI extraction)
 * @param {string} [body.method]     Payment method
 * @param {string} [body.notes]      Additional notes
 * @returns {{ success, payment?, error? }}
 */
function _handleQuickPayment(body) {
  try {
    var extracted = {};
    var stagedFileId = null;

    // 1. If image provided, upload and extract (payment context)
    if (body.image) {
      var staged = processReceiptStaged(
        body.image,
        body.fileName || 'payment.jpg',
        body.mimeType || 'image/jpeg',
        'payment'
      );

      if (staged.success) {
        extracted = staged.extracted || {};
        stagedFileId = staged.fileId;
      }
    }

    // 2. Build payment data — user overrides take precedence over extraction
    var clientId = body.clientId || '';

    // Resolve client by name if clientId not provided
    if (!clientId && body.clientName) {
      var client = lookupClientByName(body.clientName);
      if (client) clientId = client.id;
    }

    // Build notes from extraction extras
    var autoNotes = [];
    if (extracted.referenceNumber) autoNotes.push('Ref: ' + extracted.referenceNumber);
    if (extracted.invoiceNumber) autoNotes.push('Invoice: ' + extracted.invoiceNumber);
    if (extracted.notes) autoNotes.push(extracted.notes);

    var paymentData = {
      description:    body.description || extracted.description || extracted.vendor || 'Payment from Shortcut',
      amount:         body.amount || extracted.amount || 0,
      paymentDate:    body.paymentDate || extracted.date || new Date().toISOString().split('T')[0],
      method:         body.method || extracted.method || '',
      clientId:       clientId,
      invoiceId:      body.invoiceId || '',
      markPaid:       body.markPaid || false,
      notes:          body.notes || autoNotes.join(' | ') || '',
      status:         'Review',
      receiptFileId:  stagedFileId || '',
      pickerSource:   false,
      receiptUrl:     '',
    };

    // 3. Pre-generate ID and move file to correct folder with proper name
    var preGeneratedId = _generatePaymentId(paymentData.paymentDate);
    paymentData.paymentId = preGeneratedId;

    if (stagedFileId) {
      var finalFile = _moveReceiptToFinalFolder(stagedFileId, clientId, 'Payments', false, preGeneratedId);
      paymentData.receiptUrl = finalFile.fileUrl;
    }

    // 4. Log to Notion
    Logger.log('quickPayment paymentData: status=' + paymentData.status + ', amount=' + paymentData.amount);
    var result = logPayment(paymentData);
    Logger.log('quickPayment logPayment result: ' + JSON.stringify(result).substring(0, 300));

    if (result.success) {
      _cacheInvalidate(_CACHE_KEYS);
      return {
        success: true,
        payment: result.payment,
        extracted: extracted,
        notionUrl: result.payment.notionUrl || '',
        message: '$' + (paymentData.amount || 0).toFixed(2)
          + ' (' + (result.payment.paymentId || 'logged') + ')',
      };
    }

    return result;
  } catch (e) {
    Logger.log('_handleQuickPayment error: ' + e.message);
    return { success: false, error: e.message };
  }
}

/** Return a JSON ContentService response.
 *  Note: Apps Script ContentService always returns HTTP 200;
 *  errors are conveyed via { success: false, error: "..." } in the body. */
function _jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── DRAFT EMAIL (backward-compatible for sidebar/webapp) ─────

function createInvoiceDraft(params) {
  return createDocumentDraft({
    fileId:       params.fileId,
    clientEmail:  params.clientEmail,
    clientName:   params.clientName,
    documentId:   params.invoiceId,
    documentType: 'Invoice',
    total:        params.total,
    dueDate:      params.dueDate,
  });
}

// ── OPS PANEL SERVER FUNCTIONS ───────────────────────────────
// Called from panel.html via google.script.run.

/** Get all active clients for the list view. */
function panelGetClients() {
  var cached = _cacheGet('clients');
  if (cached) return cached;
  var data = getClients();
  if (!data.error) _cacheSet('clients', data);
  return data;
}

/** Get full client details + contacts + projects for client view. */
function panelGetClientDetails(clientId) {
  var data = _batchGetClientDetails(clientId);
  if (!data.client) return { error: 'Client not found' };

  var totalRevenue = 0, outstanding = 0;
  data.invoices.forEach(function(inv) {
    if (inv.status === 'Paid') totalRevenue += inv.total;
    if (inv.status === 'Sent' || inv.status === 'Overdue') outstanding += inv.total;
  });

  return { client: data.client, contacts: data.contacts, projects: data.projects, totalRevenue: totalRevenue, outstanding: outstanding };
}

/** Get project details + invoices + agreements for project dashboard. */
function panelGetProjectDetails(projectId) {
  var data = _batchGetProjectDetails(projectId);
  if (!data.project) return { error: 'Project not found' };
  return { project: data.project, invoices: data.invoices, agreements: data.agreements, clientName: data.clientName, client: data.client };
}

/** Create a new client (full flow). */
function panelCreateClient(data) {
  var result = createFullClient(data);
  if (result.success) _cacheInvalidate(_CACHE_KEYS);
  return result;
}

/** Add a contact to a client. */
function panelAddContact(data) {
  try {
    var page = createNotionContact(data);
    return { success: true, contact: { id: page.id, name: data.name, notionUrl: page.url || '' } };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/** Get a single contact by ID (for edit form). */
function panelGetContactById(contactId) {
  try {
    return getContactById(contactId);
  } catch (e) {
    Logger.log('panelGetContactById error: ' + e.message);
    return null;
  }
}

/** Update contact info fields. */
function panelUpdateContactInfo(contactId, data) {
  try {
    if (data.name !== undefined && !data.name.trim()) {
      return { success: false, error: 'Contact name cannot be empty.' };
    }
    updateContactInfo(contactId, data);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/** Set a contact as the primary contact for a client. */
function panelSetPrimaryContact(clientId, contactId) {
  try {
    _notionUpdatePage(clientId, {
      'Primary Contact': { relation: [{ id: contactId }] }
    });
    _cacheInvalidate(_CACHE_KEYS);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/** Archive (soft-delete) a contact. */
function panelArchiveContact(contactId) {
  _requireRole(['admin']);
  try {
    archiveNotionPage(contactId);
    _cacheInvalidate(_CACHE_KEYS);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/** Create a new project. */
function panelCreateProject(data) {
  var result = createProject(data);
  if (result.success) _cacheInvalidate(_CACHE_KEYS);
  return result;
}

/** Create a new agreement. */
function panelCreateAgreement(data) {
  var result = createAgreement(data);
  if (result.success) _cacheInvalidate(_CACHE_KEYS);
  return result;
}

/** Get a single agreement by ID (for edit form). */
function panelGetAgreementById(agreementId) {
  try {
    var data = _notionGet('pages/' + agreementId);
    return _mapAgreementProperties(data);
  } catch (e) {
    Logger.log('panelGetAgreementById error: ' + e.message);
    return null;
  }
}

/** Get all expenses for the expenses list view. */
function panelGetAllExpenses() {
  _requireRole(['admin', 'partner']);
  try {
    var expenses = getAllExpenses();
    if (expenses.error) return expenses;

    // Resolve client names for filtering
    var clientMap = {};
    var clients = getClients();
    if (!clients.error) {
      clients.forEach(function(c) { clientMap[c.id] = c.name; });
    }
    expenses.forEach(function(e) {
      e.clientName = clientMap[e.clientId] || '';
    });

    return expenses;
  } catch (e) {
    return { error: e.message };
  }
}

/** Log an expense. */
function panelLogExpense(data) {
  _requireRole(['admin', 'partner']);
  var result = logExpense(data);
  if (result.success) _cacheInvalidate(_CACHE_KEYS);
  return result;
}

/** Get a single expense by Notion page ID. */
function panelGetExpenseById(expensePageId) {
  try {
    var expense = getExpenseById(expensePageId);
    if (!expense) return { success: false, error: 'Expense not found.' };
    return { success: true, expense: expense };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/** Update an existing expense. */
function panelUpdateExpense(expensePageId, data) {
  try {
    var existing = getExpenseById(expensePageId);

    // If a new staged receipt was uploaded, move it to the final folder
    if (data.receiptFileId) {
      var expId = existing ? existing.expenseId : null;
      var finalFile = _moveReceiptToFinalFolder(
        data.receiptFileId,
        data.clientId || '',
        'Expenses',
        !!data.pickerSource,
        expId
      );
      data.receiptUrl = finalFile.fileUrl;
    } else {
      // Check if client changed — if so, move the existing receipt file
      var clientChanged = existing && (existing.clientId || '') !== (data.clientId || '');
      if (clientChanged && existing.receiptUrl) {
        var fileId = extractDriveFileId(existing.receiptUrl);
        if (fileId) {
          var newClientDriveFolderId = null;
          if (data.clientId) {
            var client = getClientById(data.clientId);
            if (client) newClientDriveFolderId = client.driveFolderId;
          }
          var year = existing.expenseDate ? existing.expenseDate.substring(0, 4) : new Date().getFullYear().toString();
          var targetFolder = resolveExpenseFolder(newClientDriveFolderId, year);
          if (targetFolder) {
            var moveResult = moveDriveFile(fileId, targetFolder);
            if (moveResult.success && moveResult.newUrl) {
              data.receiptUrl = moveResult.newUrl;
            }
          }
        }
      }
    }

    updateExpenseInfo(expensePageId, data);
    _cacheInvalidate(_CACHE_KEYS);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Archive (soft-delete) an expense.
 * Also trashes the associated receipt file in Drive if one exists.
 */
function panelArchiveExpense(expensePageId) {
  _requireRole(['admin']);
  try {
    // Fetch the expense first to get the receipt URL
    var expense = getExpenseById(expensePageId);
    var receiptTrashed = false;

    if (expense && expense.receiptUrl) {
      var fileId = extractDriveFileId(expense.receiptUrl);
      if (fileId) {
        receiptTrashed = trashDriveFile(fileId);
        Logger.log('panelArchiveExpense: receipt file ' + fileId + ' trashed: ' + receiptTrashed);
      }
    }

    archiveNotionPage(expensePageId);
    _cacheInvalidate(_CACHE_KEYS);
    return { success: true, receiptTrashed: receiptTrashed };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Upload a receipt and extract data via Claude Vision.
 * Called from the frontend after the user selects a file.
 *
 * @param {Object} data
 * @param {string} data.base64      Base64-encoded file content
 * @param {string} data.fileName    Original file name
 * @param {string} data.mimeType    MIME type
 * @param {string} [data.clientId]  Notion client page ID (null for overhead)
 * @returns {{ success, fileUrl?, fileId?, extracted?, extractionError?, error? }}
 */
/**
 * Upload receipt to a temporary staging folder and run AI extraction.
 * The file is NOT placed in its final folder yet — that happens at submit
 * time via panelLogExpenseFromReceipt / panelLogPaymentFromReceipt, which
 * call _moveReceiptToFinalFolder() to place it correctly.
 */
function panelUploadAndExtractReceipt(data) {
  try {
    return processReceiptStaged(data.base64, data.fileName, data.mimeType);
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Re-extract data from an already-uploaded receipt file.
 * Used if the user changes the client and wants to re-run extraction,
 * or if extraction failed and they want to retry.
 *
 * @param {string} fileId  Drive file ID
 * @returns {{ success, data?, error? }}
 */
function panelReExtractReceipt(fileId, context) {
  try {
    return extractReceiptData(fileId, context || 'expense');
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Log an expense from the receipt review form.
 * Combines receipt data (fileUrl) with user-confirmed fields.
 */
/**
 * Log an expense from the receipt review form.
 * Moves/copies the receipt file to the correct folder based on the final client selection.
 */
function panelLogExpenseFromReceipt(data) {
  try {
    // Pre-generate ID so the file can be renamed to match
    var expenseId = _generateExpenseId(data.expenseDate);
    data.expenseId = expenseId;

    // Move/copy receipt to final folder if we have a file
    if (data.receiptFileId) {
      var finalFile = _moveReceiptToFinalFolder(
        data.receiptFileId,
        data.clientId || '',
        'Expenses',
        !!data.pickerSource,
        expenseId
      );
      data.receiptUrl = finalFile.fileUrl;
    }

    var result = logExpense(data);
    if (result.success) _cacheInvalidate(_CACHE_KEYS);
    return result;
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/** Log a payment. */
function panelLogPayment(data) {
  var result = logPayment(data);
  if (result.success) {
    _cacheInvalidate(_CACHE_KEYS);
    if (data.closeProject && data.projectId) {
      try {
        setProjectStatus(data.projectId, 'Closed');
        result.projectClosed = true;
      } catch (e) {
        result.projectCloseError = e.message;
      }
    }
  }
  return result;
}

/** Get all payments for the standalone list view. */
function panelGetAllPayments() {
  _requireRole(['admin', 'partner']);
  try {
    var payments = getAllPayments();
    if (payments.error) return payments;

    // Resolve client names for filtering
    var clientMap = {};
    var clients = getClients();
    if (!clients.error) {
      clients.forEach(function(c) { clientMap[c.id] = c.name; });
    }

    // Resolve invoice numbers for display
    var invoiceMap = {};
    var invoices = getAllInvoices();
    if (!invoices.error) {
      invoices.forEach(function(inv) { invoiceMap[inv.id] = inv.invoiceId; });
    }

    payments.forEach(function(p) {
      p.clientName    = clientMap[p.clientId] || '';
      p.invoiceNumber = p.invoiceId ? (invoiceMap[p.invoiceId] || '') : '';
    });

    return payments;
  } catch (e) {
    return { error: e.message };
  }
}

/** Get a single payment by Notion page ID. */
function panelGetPaymentById(paymentPageId) {
  try {
    var payment = getPaymentById(paymentPageId);
    if (!payment) return { success: false, error: 'Payment not found.' };
    return { success: true, payment: payment };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/** Update an existing payment. */
function panelUpdatePayment(paymentPageId, data) {
  try {
    var existing = getPaymentById(paymentPageId);

    // New receipt file staged — move to final folder
    if (data.receiptFileId) {
      var payId = existing ? existing.paymentId : null;
      var clientId = data.clientId || (existing ? existing.clientId : '');
      var finalFile = _moveReceiptToFinalFolder(data.receiptFileId, clientId, 'Payments', !!data.pickerSource, payId);
      data.receiptUrl = finalFile.fileUrl;
    } else if (existing && (existing.clientId || '') !== (data.clientId || '') && existing.receiptUrl) {
      // Client changed — move existing receipt to new client folder
      var fileId = extractDriveFileId(existing.receiptUrl);
      if (fileId) {
        var newClientDriveFolderId = null;
        if (data.clientId) {
          var movedClient = getClientById(data.clientId);
          if (movedClient) newClientDriveFolderId = movedClient.driveFolderId;
        }
        var year = existing.paymentDate ? existing.paymentDate.substring(0, 4) : new Date().getFullYear().toString();
        var targetFolder = resolvePaymentFolder(newClientDriveFolderId, year);
        if (targetFolder) {
          var moveResult = moveDriveFile(fileId, targetFolder);
          if (moveResult.success && moveResult.newUrl) {
            data.receiptUrl = moveResult.newUrl;
          }
        }
      }
    }

    updatePaymentInfo(paymentPageId, data);
    _cacheInvalidate(_CACHE_KEYS);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Archive (soft-delete) a payment.
 * Also trashes the associated receipt file in Drive if one exists.
 */
function panelArchivePayment(paymentPageId) {
  _requireRole(['admin']);
  try {
    var payment = getPaymentById(paymentPageId);
    var receiptTrashed = false;

    if (payment && payment.receiptUrl) {
      var fileId = extractDriveFileId(payment.receiptUrl);
      if (fileId) {
        receiptTrashed = trashDriveFile(fileId);
        Logger.log('panelArchivePayment: receipt file ' + fileId + ' trashed: ' + receiptTrashed);
      }
    }

    archiveNotionPage(paymentPageId);
    _cacheInvalidate(_CACHE_KEYS);
    return { success: true, receiptTrashed: receiptTrashed };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Upload a payment receipt and extract data via Claude Vision.
 * Files go to the Payments folder (not Expenses).
 */
/**
 * Upload payment receipt to staging folder and run AI extraction.
 * File is placed in final folder at submit time via panelLogPaymentFromReceipt.
 */
function panelUploadAndExtractPaymentReceipt(data) {
  try {
    return processReceiptStaged(data.base64, data.fileName, data.mimeType);
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Handle a file selected via Google Picker for a payment receipt.
 * Copies to the correct Payments folder and runs AI extraction.
 */
/**
 * Extract data from a Drive-picked file for payment logging.
 * Does NOT copy the file yet — that happens at submit time.
 * Extracts from the original file directly.
 */
function panelPickerExtractPaymentReceipt(data) {
  try {
    var originalFile = DriveApp.getFileById(data.fileId);
    var extraction = extractReceiptData(data.fileId, 'payment');

    return {
      success:         true,
      fileId:          data.fileId,
      fileUrl:         originalFile.getUrl(),
      fileName:        originalFile.getName(),
      pickerSource:    true,
      extracted:       extraction.success ? extraction.data : null,
      extractionError: extraction.success ? null : extraction.error,
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/** Log a payment from the receipt review form. */
/**
 * Log a payment from the receipt review form.
 * Moves/copies the receipt file to the correct folder based on the final client selection.
 */
function panelLogPaymentFromReceipt(data) {
  try {
    // Pre-generate ID so the file can be renamed to match
    var paymentId = _generatePaymentId(data.paymentDate);
    data.paymentId = paymentId;

    // Move/copy receipt to final folder if we have a file
    if (data.receiptFileId) {
      var finalFile = _moveReceiptToFinalFolder(
        data.receiptFileId,
        data.clientId || '',
        'Payments',
        !!data.pickerSource,
        paymentId
      );
      data.receiptUrl = finalFile.fileUrl;
    }

    var result = logPayment(data);
    if (result.success) {
      _cacheInvalidate(_CACHE_KEYS);
      if (data.closeProject && data.projectId) {
        try {
          setProjectStatus(data.projectId, 'Closed');
          result.projectClosed = true;
        } catch (e) {
          result.projectCloseError = e.message;
        }
      }
    }
    return result;
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Return credentials needed by Google Picker:
 *   - OAuth token (for accessing user's Drive files)
 *   - API key (Developer Key from GCP Console)
 *   - App ID (GCP project number)
 *
 * PICKER_API_KEY and PICKER_APP_ID must be set in Script Properties.
 */
function panelGetPickerConfig() {
  var props = PropertiesService.getScriptProperties();
  return {
    token:  ScriptApp.getOAuthToken(),
    apiKey: props.getProperty('PICKER_API_KEY') || '',
    appId:  props.getProperty('PICKER_APP_ID') || '',
  };
}

/**
 * Handle a file selected via Google Picker.
 * Copies the file to the correct expense folder (with year subfolder)
 * and runs AI extraction.
 *
 * @param {Object} data
 * @param {string} data.fileId      Drive file ID of the picked file
 * @param {string} data.fileName    File name
 * @param {string} [data.clientId]  Notion client page ID (null for overhead)
 * @returns {{ success, fileId?, fileUrl?, fileName?, extracted?, extractionError?, error? }}
 */
/**
 * Extract data from a Drive-picked file for expense logging.
 * Does NOT copy the file yet — that happens at submit time.
 * Extracts from the original file directly.
 */
function panelPickerExtractReceipt(data) {
  try {
    var originalFile = DriveApp.getFileById(data.fileId);
    var extraction = extractReceiptData(data.fileId, 'expense');

    return {
      success:         true,
      fileId:          data.fileId,
      fileUrl:         originalFile.getUrl(),
      fileName:        originalFile.getName(),
      pickerSource:    true,
      extracted:       extraction.success ? extraction.data : null,
      extractionError: extraction.success ? null : extraction.error,
    };
  } catch (e) {
    Logger.log('panelPickerExtractReceipt error: ' + e.message);
    return { success: false, error: e.message };
  }
}

/** Create an email draft for a document (legacy). */
function panelCreateDraft(params) {
  return createDocumentDraft(params);
}

/** Create an email draft from pre-composed content (used by compose view). */
function panelCreateComposedDraft(params) {
  return createEmailDraft({
    to: params.to,
    subject: params.subject,
    body: params.body,
    fileId: params.fileId || '',
  });
}

/** Get primary contact email for a client. */
function panelGetPrimaryContact(clientId) {
  return getPrimaryContact(clientId);
}

// ── COMPOSE & SEND EMAIL ────────────────────────────────────

/**
 * Prepare all data needed for the compose email view.
 * Single call: looks up contact, loads templates, resolves default template.
 */
function panelGetComposeData(params) {
  try {
    var contact = getPrimaryContact(params.clientId);
    if (!contact || !contact.email) {
      return { error: 'No primary contact email found. Add a contact with an email first.' };
    }

    // Fetch client record for extra variables
    var client = null;
    if (params.clientId) {
      try { client = getClientById(params.clientId); } catch (_) {}
    }

    // Fetch project name if available
    var projectName = '';
    if (params.projectId) {
      try {
        var project = _notionGet('pages/' + params.projectId);
        projectName = project.properties['Name']?.title[0]?.plain_text || '';
      } catch (_) {}
    }

    var templateType = params.documentType === 'Invoice' ? 'invoice' : 'agreement';
    var templates = getEmailTemplates(templateType);

    // Find requested template or use first available
    var template = templates[0];
    if (params.templateId) {
      for (var i = 0; i < templates.length; i++) {
        if (templates[i].id === params.templateId) { template = templates[i]; break; }
      }
    }

    // Format dates for display
    var dueFormatted = params.dueDate || '';
    if (dueFormatted && /^\d{4}-\d{2}-\d{2}$/.test(dueFormatted)) {
      try {
        var d = new Date(dueFormatted + 'T12:00:00');
        dueFormatted = d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
      } catch (_) {}
    }
    var issueFormatted = params.issueDate || '';
    if (issueFormatted && /^\d{4}-\d{2}-\d{2}$/.test(issueFormatted)) {
      try {
        var d2 = new Date(issueFormatted + 'T12:00:00');
        issueFormatted = d2.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
      } catch (_) {}
    }

    var totalNum = params.total ? parseFloat(params.total).toFixed(2) : '';

    var variables = buildTemplateVariables({
      clientName:    client ? client.name : contact.name,
      clientEmail:   contact.email,
      clientPhone:   client ? client.phone : '',
      clientWebsite: client ? client.website : '',
      contactName:   contact.name,
      contactRole:   contact.role || '',
      documentId:    params.documentId,
      documentType:  params.documentType,
      projectName:   projectName,
      total:         totalNum,
      balanceDue:    params.balanceDue || totalNum,
      issueDate:     issueFormatted,
      dueDate:       dueFormatted,
      driveLink:     params.driveLink || '',
    });

    var subject = resolveTemplateVariables(template.subject, variables);
    var body = resolveTemplateVariables(template.body, variables);

    return {
      contact: { name: contact.name, email: contact.email },
      templates: templates.map(function(t) {
        return { id: t.id, name: t.name, isDefault: !!t.isDefault };
      }),
      selectedTemplateId: template.id,
      subject: subject,
      body: body,
      variables: variables,
    };
  } catch (e) {
    return { error: e.message };
  }
}

/** Resolve a specific template with variables (for template switch in compose view). */
function panelResolveTemplate(templateId, variables) {
  try {
    var templates = getEmailTemplates();
    var template = null;
    for (var i = 0; i < templates.length; i++) {
      if (templates[i].id === templateId) { template = templates[i]; break; }
    }
    if (!template) return { error: 'Template not found.' };
    return {
      subject: resolveTemplateVariables(template.subject, variables),
      body: resolveTemplateVariables(template.body, variables),
    };
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * Send an email and auto-update document status to "Sent".
 * If email fails, status is NOT updated. If status update fails, a warning is returned.
 */
function panelSendDocumentEmail(params) {
  // Step 1: Send the email
  var emailResult = sendEmail({
    to: params.to,
    subject: params.subject,
    body: params.body,
    fileId: params.fileId || '',
  });

  if (!emailResult.success) {
    return { success: false, error: emailResult.error };
  }

  // Step 2: Update document status to "Sent"
  var statusError = null;
  try {
    if (params.entityType === 'invoice') {
      updateInvoiceStatus(params.entityId, 'Sent', null);
    } else if (params.entityType === 'agreement') {
      updateAgreementStatus(params.entityId, 'Sent');
    }
    _cacheInvalidate(_CACHE_KEYS);
  } catch (e) {
    statusError = e.message;
  }

  var result = { success: true };
  if (statusError) result.statusUpdateError = statusError;
  return result;
}

// ── EMAIL TEMPLATE MANAGEMENT ───────────────────────────────

/** Get all email templates (defaults + custom). */
function panelGetEmailTemplates() {
  return getEmailTemplates();
}

/** Save a custom email template (create new or update existing). */
function panelSaveEmailTemplate(template) {
  _requireRole(['admin']);
  try {
    if (!template.name || !template.name.trim()) return { success: false, error: 'Template name is required.' };
    if (!template.type) return { success: false, error: 'Template type is required.' };
    if (!template.subject || !template.subject.trim()) return { success: false, error: 'Subject is required.' };
    if (!template.body || !template.body.trim()) return { success: false, error: 'Body is required.' };

    var raw = PropertiesService.getScriptProperties().getProperty('email_templates');
    var customs = raw ? JSON.parse(raw) : [];

    if (template.id) {
      // Update existing (custom or customized default)
      var found = false;
      for (var i = 0; i < customs.length; i++) {
        if (customs[i].id === template.id) {
          customs[i].name = template.name.trim();
          customs[i].type = template.type;
          customs[i].subject = template.subject.trim();
          customs[i].body = template.body.trim();
          found = true;
          break;
        }
      }
      if (!found) {
        // May be a default template being customized for the first time
        var isDefaultId = template.id.indexOf('default_') === 0;
        if (isDefaultId) {
          customs.push({
            id: template.id,
            name: template.name.trim(),
            type: template.type,
            subject: template.subject.trim(),
            body: template.body.trim(),
          });
        } else {
          return { success: false, error: 'Template not found.' };
        }
      }
    } else {
      // Create new
      template = {
        id: 'tpl_' + Date.now(),
        name: template.name.trim(),
        type: template.type,
        subject: template.subject.trim(),
        body: template.body.trim(),
      };
      customs.push(template);
    }

    PropertiesService.getScriptProperties().setProperty('email_templates', JSON.stringify(customs));
    return { success: true, template: template };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/** Delete a custom email template. */
function panelDeleteEmailTemplate(templateId) {
  _requireRole(['admin']);
  try {
    var raw = PropertiesService.getScriptProperties().getProperty('email_templates');
    var customs = raw ? JSON.parse(raw) : [];
    var filtered = customs.filter(function(t) { return t.id !== templateId; });
    if (filtered.length === customs.length) {
      return { success: false, error: 'Template not found or is a built-in default.' };
    }
    PropertiesService.getScriptProperties().setProperty('email_templates', JSON.stringify(filtered));
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/** Reset a customized default template back to its original. */
function panelResetEmailTemplate(templateId) {
  _requireRole(['admin']);
  try {
    // Only allow resetting default templates
    if (templateId.indexOf('default_') !== 0) {
      return { success: false, error: 'Only customized default templates can be reset.' };
    }
    var raw = PropertiesService.getScriptProperties().getProperty('email_templates');
    var customs = raw ? JSON.parse(raw) : [];
    var filtered = customs.filter(function(t) { return t.id !== templateId; });
    if (filtered.length === customs.length) {
      return { success: false, error: 'Template has not been customized.' };
    }
    PropertiesService.getScriptProperties().setProperty('email_templates', JSON.stringify(filtered));
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/** Update project status. */
function panelUpdateProjectStatus(projectId, status) {
  var result = setProjectStatus(projectId, status);
  if (result.success) _cacheInvalidate(_CACHE_KEYS);
  return result;
}

/** Update invoice status. */
function panelUpdateInvoiceStatus(invoiceId, status) {
  try {
    var validStatuses = ['Draft', 'Sent', 'Paid', 'Overdue', 'Void'];
    if (validStatuses.indexOf(status) === -1) {
      return { success: false, error: 'Invalid status. Must be one of: ' + validStatuses.join(', ') };
    }
    updateInvoiceStatus(invoiceId, status, status === 'Paid' ? new Date().toISOString().split('T')[0] : null);
    _cacheInvalidate(_CACHE_KEYS);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/** Update agreement status. */
function panelUpdateAgreementStatus(agreementId, status) {
  try {
    var validStatuses = ['Draft', 'Sent', 'Signed', 'Void'];
    if (validStatuses.indexOf(status) === -1) {
      return { success: false, error: 'Invalid status. Must be one of: ' + validStatuses.join(', ') };
    }
    updateAgreementStatus(agreementId, status);
    _cacheInvalidate(_CACHE_KEYS);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── DASHBOARD ─────────────────────────────────────────────────

/** Get aggregated KPIs for the dashboard. */
function panelGetDashboardData() {
  var cached = _cacheGet('dashboard');
  if (cached) return cached;

  var clients  = getClients();
  var projects = getProjects();

  // Dual-fetch strategy:
  //   Time-bounded  — current fiscal year invoices/expenses (for revenue, charts)
  //   Status-bounded — all outstanding invoices regardless of age (for overdue alerts)
  var now = new Date();
  var yearStart = now.getFullYear() + '-01-01';
  var todayISO  = now.toISOString().split('T')[0];
  var yearInvoices        = getInvoicesByDateRange(yearStart, todayISO);
  var outstandingInvoices = getInvoicesByStatus(['Sent', 'Overdue']);
  var expenses            = getExpensesByDateRange(yearStart, todayISO);

  if (clients.error)              clients  = [];
  if (projects.error)             projects = [];
  if (yearInvoices.error)         yearInvoices = [];
  if (outstandingInvoices.error)  outstandingInvoices = [];
  if (expenses.error)             expenses = [];

  // Merge and dedup: year invoices + outstanding (some may overlap)
  var seen = {};
  var invoices = [];
  yearInvoices.concat(outstandingInvoices).forEach(function(inv) {
    if (!seen[inv.id]) { seen[inv.id] = true; invoices.push(inv); }
  });

  // Sort by issuedDate descending for the "recent" slice
  invoices.sort(function(a, b) {
    return (b.issuedDate || '').localeCompare(a.issuedDate || '');
  });

  var totalRevenue = 0, outstanding = 0, overdueCount = 0, paidCount = 0;
  var recentInvoices = [];
  var overdueInvoices = [];
  var monthlyRevenue = {};

  // Build client map for name lookups
  var clientMap = {};
  clients.forEach(function(c) { clientMap[c.id] = c.name; });

  invoices.forEach(function(inv) {
    if (inv.status === 'Paid') { totalRevenue += inv.total; paidCount++; }
    if (inv.status === 'Sent' || inv.status === 'Overdue') outstanding += inv.total;
    if (inv.status === 'Overdue' || (inv.status === 'Sent' && inv.dueDate && inv.dueDate < todayISO)) {
      overdueCount++;
      overdueInvoices.push({
        id: inv.id,
        invoiceId: inv.invoiceId,
        clientId: inv.clientId,
        clientName: clientMap[inv.clientId] || 'Unknown',
        total: inv.total,
        dueDate: inv.dueDate,
        status: inv.status
      });
    }

    // Monthly revenue (paid invoices by paid date or issued date)
    var monthKey = (inv.paidDate || inv.issuedDate || '').substring(0, 7);
    if (inv.status === 'Paid' && monthKey) {
      monthlyRevenue[monthKey] = (monthlyRevenue[monthKey] || 0) + inv.total;
    }

    // Recent invoices (last 5, already sorted)
    if (recentInvoices.length < 5) recentInvoices.push(inv);
  });

  var totalExpenses = 0;
  expenses.forEach(function(exp) { totalExpenses += exp.amount; });

  // Build recent projects list with client names for dashboard
  var activeProjectList = projects.filter(function(p) { return p.status === 'Active'; });
  var draftProjectList  = projects.filter(function(p) { return p.status === 'Draft'; });
  var recentProjects = activeProjectList.concat(draftProjectList).slice(0, 5).map(function(p) {
    return {
      id: p.id,
      name: p.name,
      clientName: clientMap[p.clientId] || '',
      clientId: p.clientId || '',
      type: p.type || '',
      status: p.status || '',
    };
  });

  var result = {
    clientCount: clients.length,
    projectCount: projects.length,
    activeProjects: activeProjectList.length,
    draftProjects: draftProjectList.length,
    totalRevenue: totalRevenue,
    outstanding: outstanding,
    overdueCount: overdueCount,
    paidCount: paidCount,
    invoiceCount: invoices.length,
    totalExpenses: totalExpenses,
    profit: totalRevenue - totalExpenses,
    recentInvoices: recentInvoices,
    overdueInvoices: overdueInvoices,
    monthlyRevenue: monthlyRevenue,
    recentProjects: recentProjects,
  };
  _cacheSet('dashboard', result);
  return result;
}

// ── EDIT RECORDS ──────────────────────────────────────────────

/** Update client info fields. */
function panelUpdateClientInfo(clientId, data) {
  try {
    if (data.name !== undefined && !data.name.trim()) {
      return { success: false, error: 'Client name cannot be empty.' };
    }
    updateClientInfo(clientId, data);
    _cacheInvalidate(_CACHE_KEYS);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/** Update project info fields. */
function panelUpdateProjectInfo(projectId, data) {
  try {
    if (data.name !== undefined && !data.name.trim()) {
      return { success: false, error: 'Project name cannot be empty.' };
    }
    updateProjectInfo(projectId, data);
    _cacheInvalidate(_CACHE_KEYS);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/** Update agreement info fields. */
function panelUpdateAgreementInfo(agreementId, data) {
  try {
    if (data.title !== undefined && !data.title.trim()) {
      return { success: false, error: 'Agreement title cannot be empty.' };
    }
    updateAgreementInfo(agreementId, data);
    _cacheInvalidate(_CACHE_KEYS);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── INVOICE DETAIL ────────────────────────────────────────────

/** Get all invoices enriched with client names for the Invoices list view. */
function panelGetAllInvoices() {
  _requireRole(['admin', 'partner']);
  try {
    var invoices = getAllInvoices();
    if (invoices.error) return invoices;

    var clientMap = {};
    var clients = getClients();
    if (!clients.error) {
      clients.forEach(function(c) { clientMap[c.id] = c.name; });
    }

    var projectMap = {};
    var projects = getProjects();
    if (!projects.error) {
      projects.forEach(function(p) { projectMap[p.id] = p.name; });
    }

    invoices.forEach(function(inv) {
      inv.clientName  = clientMap[inv.clientId]   || '';
      inv.projectName = projectMap[inv.projectId] || '';
    });
    return invoices;
  } catch (e) {
    return { error: e.message };
  }
}

/** Get invoice details + payments for invoice view. */
function panelGetInvoiceDetails(invoiceId) {
  var invoice = getInvoiceById(invoiceId);
  if (!invoice) return { error: 'Invoice not found' };
  var payments = getPaymentsByInvoice(invoiceId);
  if (payments && payments.error) { Logger.log('Payments query error: ' + payments.error); payments = []; }
  var client = invoice.clientId ? getClientById(invoice.clientId) : null;
  return {
    invoice: invoice,
    payments: payments,
    clientName: client ? client.name : '',
    withholdingAgent: client ? (client.withholdingAgent || false) : false,
    withholdingRate: client ? ((client.withholdingRate || 10) / 100) : 0.10,
  };
}

// ── AGREEMENT DETAIL ─────────────────────────────────────────

/** Get agreement details for agreement view. */
function panelGetAgreementDetails(agreementId) {
  try {
    var raw = _notionGet('pages/' + agreementId);
    if (!raw || raw.error) return { error: 'Agreement not found' };
    var agreement = _mapAgreementProperties(raw);
    var clientName = '';
    if (agreement.clientId) {
      var client = getClientById(agreement.clientId);
      if (client && !client.error) clientName = client.name;
    }
    return { agreement: agreement, clientName: clientName };
  } catch (e) {
    return { error: e.message };
  }
}

// ── OVERDUE INVOICE TRIGGER ───────────────────────────────────

/**
 * Time-driven trigger — run daily to auto-flag overdue invoices.
 * Set up via Apps Script Triggers: checkOverdueInvoices, daily.
 */
function checkOverdueInvoices() {
  var today = new Date().toISOString().split('T')[0];

  // Fetch only Sent invoices with Due Date before today (server-side filter)
  var invoices = getSentInvoicesDueBefore(today);
  if (invoices.error) { Logger.log('checkOverdueInvoices: ' + invoices.error); return; }
  if (!invoices.length) { Logger.log('checkOverdueInvoices: no overdue invoices found.'); return; }

  // Batch all status updates in parallel
  var specs = invoices.map(function(inv) {
    return {
      method: 'patch',
      endpoint: 'pages/' + inv.id,
      payload: { properties: { 'Status': { select: { name: 'Overdue' } } } }
    };
  });
  var results = _notionBatchRequest(specs);
  var updated = 0;
  results.forEach(function(res, i) {
    if (res.error) {
      Logger.log('Failed to mark overdue: ' + invoices[i].invoiceId + ' — ' + res.error);
    } else {
      updated++;
    }
  });
  Logger.log('checkOverdueInvoices: marked ' + updated + ' invoices as overdue.');
}

// ── FINANCIAL REPORT ──────────────────────────────────────────

/** Get full financial data for reporting. */
function panelGetFinancialReport() {
  _requireRole(['admin', 'partner']);
  var cached = _cacheGet('financialReport');
  if (cached) return cached;

  var clients  = getClients();
  var projects = getProjects();

  // Dual-fetch: date-scoped for revenue/expenses, status-scoped for AR aging
  var now = new Date();
  var yearStart = now.getFullYear() + '-01-01';
  var todayISO  = now.toISOString().split('T')[0];
  var yearInvoices        = getInvoicesByDateRange(yearStart, todayISO);
  var outstandingInvoices = getInvoicesByStatus(['Sent', 'Overdue']);
  var expenses            = getExpensesByDateRange(yearStart, todayISO);

  if (clients.error)              clients  = [];
  if (projects.error)             projects = [];
  if (yearInvoices.error)         yearInvoices = [];
  if (outstandingInvoices.error)  outstandingInvoices = [];
  if (expenses.error)             expenses = [];

  // Merge and dedup
  var seen = {};
  var invoices = [];
  yearInvoices.concat(outstandingInvoices).forEach(function(inv) {
    if (!seen[inv.id]) { seen[inv.id] = true; invoices.push(inv); }
  });

  // Build lookup maps
  var clientMap = {};
  clients.forEach(function(c) { clientMap[c.id] = c.name; });
  var projectMap = {};
  projects.forEach(function(p) { projectMap[p.id] = { name: p.name, clientId: p.clientId }; });

  // Revenue by client
  var revenueByClient = {};
  invoices.forEach(function(inv) {
    if (inv.status !== 'Paid') return;
    var cid = inv.clientId || 'unknown';
    var cname = clientMap[cid] || 'Unknown';
    revenueByClient[cname] = (revenueByClient[cname] || 0) + inv.total;
  });

  // Revenue by project
  var revenueByProject = {};
  invoices.forEach(function(inv) {
    if (inv.status !== 'Paid') return;
    var pid = inv.projectId || 'unknown';
    var pname = projectMap[pid] ? projectMap[pid].name : 'Unknown';
    revenueByProject[pname] = (revenueByProject[pname] || 0) + inv.total;
  });

  // Revenue by month
  var revenueByMonth = {};
  invoices.forEach(function(inv) {
    if (inv.status !== 'Paid') return;
    var key = (inv.paidDate || inv.issuedDate || '').substring(0, 7);
    if (key) revenueByMonth[key] = (revenueByMonth[key] || 0) + inv.total;
  });

  // Expenses by project (internal — used for profit calc)
  var expensesByProject = {};
  expenses.forEach(function(exp) {
    var pid = exp.projectId || 'unknown';
    var pname = projectMap[pid] ? projectMap[pid].name : 'Unknown';
    expensesByProject[pname] = (expensesByProject[pname] || 0) + exp.amount;
  });

  // Expenses by category
  var expensesByCategory = {};
  expenses.forEach(function(exp) {
    var cat = exp.category || 'Uncategorized';
    expensesByCategory[cat] = (expensesByCategory[cat] || 0) + (exp.amount || 0);
  });

  // Profit by project
  var profitByProject = {};
  var allProjNames = {};
  Object.keys(revenueByProject).forEach(function(k) { allProjNames[k] = true; });
  Object.keys(expensesByProject).forEach(function(k) { allProjNames[k] = true; });
  Object.keys(allProjNames).forEach(function(k) {
    profitByProject[k] = (revenueByProject[k] || 0) - (expensesByProject[k] || 0);
  });

  // AR Aging — use true remaining balance (accounts for partial payments & withholding)
  var allPayments = getAllPayments();
  var settledByInvoice = {};
  if (!allPayments.error) {
    allPayments.forEach(function(p) {
      if (p.invoiceId) {
        settledByInvoice[p.invoiceId] = (settledByInvoice[p.invoiceId] || 0)
          + (p.amount || 0) + (p.amountWithheld || 0);
      }
    });
  }

  var aging = { current: 0, days30: 0, days60: 0, days90: 0 };
  invoices.forEach(function(inv) {
    if (inv.status !== 'Sent' && inv.status !== 'Overdue') return;
    if (!inv.dueDate) return;
    var settled = settledByInvoice[inv.id] || 0;
    var balance = Math.max(0, inv.total - settled);
    if (balance <= 1.00) return; // within rounding threshold
    var due = new Date(inv.dueDate + 'T12:00:00');
    var daysOld = Math.floor((now - due) / 86400000);
    if (daysOld <= 0) aging.current += balance;
    else if (daysOld <= 30) aging.days30 += balance;
    else if (daysOld <= 60) aging.days60 += balance;
    else aging.days90 += balance;
  });

  var result = {
    revenueByClient:   revenueByClient,
    revenueByMonth:    revenueByMonth,
    expensesByCategory: expensesByCategory,
    profitByProject:   profitByProject,
    aging:             aging,
  };
  _cacheSet('financialReport', result);
  return result;
}

// ── TAX SUMMARY ───────────────────────────────────────────────

/**
 * Generate a tax-year summary: income, expenses by category,
 * contractor payments (1099 reference), and net profit.
 * Income = payments received in the year (cash basis).
 * Expenses = expenses dated within the year.
 *
 * @param {number} year  Four-digit tax year (e.g. 2026)
 * @returns {Object}
 */
function panelGetTaxSummary(year) {
  _requireRole(['admin', 'partner']);
  try {
    var yearStr   = String(year || new Date().getFullYear());
    var startDate = yearStr + '-01-01';
    var endDate   = yearStr + '-12-31';

    var invoices    = getInvoicesByDateRange(startDate, endDate);
    var expenses    = getExpensesByDateRange(startDate, endDate);
    var allPayments = getAllPayments();
    var contractors = getAllContractors();

    if (invoices.error)    invoices    = [];
    if (expenses.error)    expenses    = [];
    if (allPayments.error) allPayments = [];
    if (contractors.error) contractors = [];

    // Contractor name lookup
    var contractorMap = {};
    contractors.forEach(function(c) { contractorMap[c.id] = c.name; });

    // Gross invoiced — non-void, non-draft invoices issued this year
    var grossInvoiced = 0;
    invoices.forEach(function(inv) {
      if (inv.status === 'Void' || inv.status === 'Draft') return;
      grossInvoiced += inv.total || 0;
    });

    // Cash received + withheld — payments dated within this year
    var cashReceived   = 0;
    var amountWithheld = 0;
    allPayments.forEach(function(p) {
      var pd = p.paymentDate || '';
      if (!pd || pd < startDate || pd > endDate) return;
      cashReceived   += p.amount          || 0;
      amountWithheld += p.amountWithheld  || 0;
    });

    // Expenses
    var totalExpenses      = 0;
    var expensesByCategory = {};
    var contractorPayments = {};
    expenses.forEach(function(exp) {
      var amt = exp.amount || 0;
      totalExpenses += amt;
      var cat = exp.category || 'Uncategorized';
      expensesByCategory[cat] = (expensesByCategory[cat] || 0) + amt;
      // Break down contractor payments by contractor for 1099 reference
      if (cat === 'Contractor Payments') {
        var cname = exp.contractorId
          ? (contractorMap[exp.contractorId] || 'Unknown Contractor')
          : 'Unlinked';
        contractorPayments[cname] = (contractorPayments[cname] || 0) + amt;
      }
    });

    var totalReceived = cashReceived + amountWithheld;

    return {
      success:            true,
      year:               yearStr,
      grossInvoiced:      grossInvoiced,
      cashReceived:       cashReceived,
      amountWithheld:     amountWithheld,
      totalReceived:      totalReceived,
      totalExpenses:      totalExpenses,
      expensesByCategory: expensesByCategory,
      contractorPayments: contractorPayments,
      netProfit:          totalReceived - totalExpenses,
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/** Get all projects (enriched with client names) for the Projects view. */
function panelGetAllProjects() {
  var cached = _cacheGet('projects');
  if (cached) return cached;
  var projects = getProjects();
  if (projects.error) return projects;
  var clients = panelGetClients(); // uses client cache if warm
  var clientMap = {};
  if (!clients.error) {
    clients.forEach(function(c) { clientMap[c.id] = c.name; });
  }
  projects.forEach(function(p) {
    p.clientName = p.clientId ? (clientMap[p.clientId] || '') : '';
  });
  _cacheSet('projects', projects);
  return projects;
}

// ── SETTINGS (PropertiesService) ─────────────────────────────

var _SETTINGS_DEFAULTS = {
  reminders: { enabled: false, daysBefore: 3, overdueIntervals: [7, 14, 30] },
  backup:    { frequency: 'weekly', spreadsheetId: '', lastBackup: '', folderId: '' }
};

function panelGetSettings() {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty('settings_reminders');
    var reminders = raw ? JSON.parse(raw) : _SETTINGS_DEFAULTS.reminders;
    return { reminders: reminders, company: getCompanyInfo() };
  } catch (e) {
    return { reminders: _SETTINGS_DEFAULTS.reminders, company: getCompanyInfo() };
  }
}

/**
 * Save company info to Script Properties.
 * Keys: company_name, company_email, company_address, company_phone
 */
function panelSaveCompanyInfo(data) {
  _requireRole(['admin']);
  try {
    var sp = PropertiesService.getScriptProperties();
    if (data.name    !== undefined) sp.setProperty('company_name',    data.name.trim());
    if (data.email   !== undefined) sp.setProperty('company_email',   data.email.trim());
    if (data.address !== undefined) sp.setProperty('company_address', data.address.trim());
    if (data.phone   !== undefined) sp.setProperty('company_phone',   data.phone.trim());
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function panelSaveSettings(data) {
  _requireRole(['admin']);
  try {
    if (data.reminders) {
      var r = {
        enabled: !!data.reminders.enabled,
        daysBefore: Math.max(1, parseInt(data.reminders.daysBefore) || 3),
        overdueIntervals: (data.reminders.overdueIntervals || [7, 14, 30]).map(function(n) { return parseInt(n) || 7; })
      };
      PropertiesService.getScriptProperties().setProperty('settings_reminders', JSON.stringify(r));
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── CONTRACTORS ──────────────────────────────────────────────

function panelGetAllContractors() {
  _requireRole(['admin', 'partner']);
  try {
    var cached = _cacheGet('contractors');
    if (cached) return cached;
    var result = getAllContractors();
    if (result && result.error) return { error: result.error };
    _cacheSet('contractors', result);
    return result;
  } catch (e) {
    return { error: e.message };
  }
}

function panelGetContractorById(contractorId) {
  return getContractorById(contractorId);
}

function panelGetContractorDetails(contractorId) {
  try {
    var data = _batchGetContractorDetails(contractorId);
    if (!data.contractor) return { success: false, error: 'Contractor not found.' };
    var totalExpenses = data.expenses.reduce(function(sum, e) { return sum + e.amount; }, 0);
    return { success: true, contractor: data.contractor, expenses: data.expenses, totalExpenses: totalExpenses };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function panelCreateContractor(data) {
  try {
    if (!data.name || !data.name.trim()) return { success: false, error: 'Contractor name is required.' };
    var page = createNotionContractor(data);
    return { success: true, contractor: { id: page.id, name: data.name, notionUrl: page.url || '' } };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function panelUpdateContractorInfo(contractorId, data) {
  try {
    updateContractorInfo(contractorId, data);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Upload a W-9 file for a contractor.
 * Saves to 01_Admin/Financials/W-9s/{contractorName} - W9.{ext}
 *
 * @param {Object} data
 * @param {string} data.base64     Base64-encoded file content
 * @param {string} data.fileName   Original file name
 * @param {string} data.mimeType   MIME type
 * @param {string} data.contractorName  Contractor name (for file naming)
 * @returns {{ success, fileUrl?, error? }}
 */
function panelUploadW9(data) {
  try {
    var folderId = resolveOrCreateSubfolder(CONFIG.FINANCIALS_DRIVE_DIR, 'W-9s');
    if (!folderId) return { success: false, error: 'Could not resolve or create W-9s folder.' };

    // Name the file: "ContractorName - W9.ext"
    var ext = data.fileName.split('.').pop() || 'pdf';
    var cleanName = (data.contractorName || 'Contractor').replace(/[\/\\]/g, '-');
    var finalName = cleanName + ' - W9.' + ext;

    var upload = uploadFileToDrive(data.base64, finalName, data.mimeType, folderId);
    return { success: true, fileUrl: upload.fileUrl, fileName: upload.fileName };
  } catch (e) {
    Logger.log('panelUploadW9 error: ' + e.message);
    return { success: false, error: e.message };
  }
}

function panelArchiveContractor(contractorId) {
  _requireRole(['admin']);
  try {
    archiveNotionPage(contractorId);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}


// ── ARCHIVING ────────────────────────────────────────────────

function panelArchiveClient(clientId) {
  _requireRole(['admin']);
  try {
    updateClientInfo(clientId, { status: 'Inactive' });
    _cacheInvalidate(_CACHE_KEYS);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function panelArchiveProject(projectId) {
  _requireRole(['admin']);
  try {
    updateProjectInfo(projectId, { status: 'Closed' });
    _cacheInvalidate(_CACHE_KEYS);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/** Delete a project by archiving it in Notion (recoverable from Notion trash). */
function panelDeleteProject(projectId) {
  _requireRole(['admin']);
  try {
    archiveNotionPage(projectId);
    _cacheInvalidate(_CACHE_KEYS);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Delete an invoice: trash the Notion page and its Drive PDF (if any).
 * @param {string} invoicePageId  Notion page ID
 * @param {string} [driveLink]    Google Drive URL of the invoice PDF
 * @returns {Object} { success, error? }
 */
function panelDeleteInvoice(invoicePageId, driveLink) {
  _requireRole(['admin']);
  try {
    archiveNotionPage(invoicePageId);

    // Trash the Drive PDF if a link was provided
    if (driveLink) {
      try {
        var match = driveLink.match(/\/d\/([a-zA-Z0-9_-]+)/);
        if (match) {
          DriveApp.getFileById(match[1]).setTrashed(true);
        }
      } catch (e) {
        Logger.log('panelDeleteInvoice: could not trash Drive file — ' + e.message);
      }
    }

    _cacheInvalidate(_CACHE_KEYS);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Void the original invoice, generate a replacement, and optionally
 * re-link logged payments to the new invoice.
 * @param {string}   originalInvoicePageId  - Notion page ID of invoice to void.
 * @param {Object}   data                   - Same shape as panelQuickCreateInvoice data.
 * @param {string[]} paymentIdsToTransfer   - Notion page IDs of payments to re-link.
 */
function panelReviseInvoice(originalInvoicePageId, data, paymentIdsToTransfer) {
  _requireRole(['admin']);
  try {
    var original = getInvoiceById(originalInvoicePageId);
    if (!original) return { success: false, error: 'Original invoice not found.' };
    if (original.status === 'Void') return { success: false, error: 'Invoice is already voided.' };

    if (!data.clientId) return { success: false, error: 'Client ID is required.' };
    if (!data.lineItems || !data.lineItems.length) return { success: false, error: 'At least one line item is required.' };

    var client = getClientById(data.clientId);
    if (!client) return { success: false, error: 'Client not found.' };

    var issueISO  = data.issueDateISO || new Date().toISOString().split('T')[0];
    var dueISO    = data.dueDateISO   || _addDays(issueISO, 14);
    var lineItems = data.lineItems.map(function(i) {
      return { name: i.name || '', description: i.description || '', qty: i.qty || 1, price: i.price || 0 };
    });
    var subtotal = lineItems.reduce(function(s, i) { return s + i.qty * i.price; }, 0);
    var taxes    = parseFloat(data.tax || 0);

    var invoiceData = {
      clientId:      client.id,
      clientName:    client.name,
      driveFolderId: client.driveFolderId || '',
      clientStreet:  client.billingStreet  || '',
      clientCity:    client.billingCity    || '',
      clientState:   client.billingState   || '',
      clientZip:     client.billingZip     || '',
      clientCountry: client.billingCountry || '',
      clientPhone:   client.phone          || '',
      clientEmail:   client.billingEmail   || '',
      clientWebsite: client.website        || '',
      projectId:     data.projectId || '',
      issueDate:     _formatDateForDoc(issueISO),
      dueDate:       _formatDateForDoc(dueISO),
      issueDateISO:  issueISO,
      dueDateISO:    dueISO,
      invoiceType:   data.invoiceType || 'Final',
      lineItems:     lineItems,
      subtotal:      subtotal,
      taxes:         taxes,
      total:         subtotal + taxes,
      exportPdf:     true,
      logToNotion:   true,
    };

    var result = generateInvoice(invoiceData);
    if (!result.success) return result;

    // Void the original
    updateInvoiceStatus(originalInvoicePageId, 'Void', null);

    // Transfer payments to the new invoice
    var paymentsMoved = 0;
    if (paymentIdsToTransfer && paymentIdsToTransfer.length && result.pageId) {
      paymentIdsToTransfer.forEach(function(paymentPageId) {
        try {
          updatePaymentInfo(paymentPageId, { invoiceId: result.pageId });
          paymentsMoved++;
        } catch (e) {
          Logger.log('panelReviseInvoice: could not transfer payment ' + paymentPageId + ' — ' + e.message);
        }
      });
    }

    _cacheInvalidate(_CACHE_KEYS);
    return {
      success:       true,
      invoiceId:     result.invoiceId,
      url:           result.url,
      voidedId:      original.invoiceId,
      paymentsMoved: paymentsMoved,
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── QUOTES ───────────────────────────────────────────────────

function panelGetAllQuotes() {
  _requireRole(['admin', 'partner']);
  try {
    return getAllQuotes();
  } catch (e) {
    return { error: e.message };
  }
}

function panelGetQuoteDetails(quotePageId) {
  try {
    var quote = getQuoteById(quotePageId);
    if (!quote) return { error: 'Quote not found' };
    var client  = quote.clientId  ? getClientById(quote.clientId)   : null;
    var project = quote.projectId ? getProjectById(quote.projectId) : null;
    return {
      quote:       quote,
      clientName:  client  ? client.name  : '',
      projectName: project ? project.name : '',
    };
  } catch (e) {
    return { error: e.message };
  }
}

function panelCreateQuote(data) {
  _requireRole(['admin', 'partner']);
  try {
    if (!data.clientId) return { success: false, error: 'Client is required.' };
    if (!data.lineItems || !data.lineItems.length) return { success: false, error: 'At least one line item is required.' };

    var client = getClientById(data.clientId);
    if (!client) return { success: false, error: 'Client not found.' };

    var issueISO = data.issueDateISO || new Date().toISOString().split('T')[0];
    var validISO = data.validDateISO || _addDays(issueISO, 30);
    var lineItems = data.lineItems.map(function(i) {
      return { name: i.name || '', description: i.description || '', qty: i.qty || 1, price: i.price || 0 };
    });
    var subtotal = lineItems.reduce(function(s, i) { return s + i.qty * i.price; }, 0);
    var taxes    = parseFloat(data.tax || 0);

    var quoteData = {
      clientId:      client.id,
      clientName:    client.name,
      driveFolderId: client.driveFolderId || '',
      clientStreet:  client.billingStreet  || '',
      clientCity:    client.billingCity    || '',
      clientState:   client.billingState   || '',
      clientZip:     client.billingZip     || '',
      clientCountry: client.billingCountry || '',
      clientPhone:   client.phone          || '',
      clientEmail:   client.billingEmail   || '',
      clientWebsite: client.website        || '',
      projectId:     data.projectId || '',
      issueDate:     _formatDateForDoc(issueISO),
      validDate:     _formatDateForDoc(validISO),
      issueDateISO:  issueISO,
      validDateISO:  validISO,
      lineItems:     lineItems,
      subtotal:      subtotal,
      taxes:         taxes,
      total:         subtotal + taxes,
      logToNotion:   true,
    };

    var result = generateQuote(quoteData);
    if (result.success) _cacheInvalidate(_CACHE_KEYS);
    return result;
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function panelUpdateQuoteStatus(quotePageId, status) {
  _requireRole(['admin', 'partner']);
  try {
    updateQuoteStatus(quotePageId, status);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function panelDeleteQuote(quotePageId, driveLink) {
  _requireRole(['admin']);
  try {
    archiveNotionPage(quotePageId);
    if (driveLink) {
      try {
        var match = driveLink.match(/\/d\/([a-zA-Z0-9_-]+)/);
        if (match) DriveApp.getFileById(match[1]).setTrashed(true);
      } catch (e) {
        Logger.log('panelDeleteQuote: could not trash Drive file — ' + e.message);
      }
    }
    _cacheInvalidate(_CACHE_KEYS);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Edit an existing quote: regenerate the PDF with updated data,
 * trash the old Drive PDF, and update the Notion record in-place.
 * @param {string} quotePageId - Notion page ID of the quote to edit.
 * @param {Object} data        - { issueDateISO, validDateISO, lineItems, tax, notes }
 */
function panelEditQuote(quotePageId, data) {
  _requireRole(['admin', 'partner']);
  try {
    var quote = getQuoteById(quotePageId);
    if (!quote) return { success: false, error: 'Quote not found.' };
    if (quote.status === 'Converted') return { success: false, error: 'Cannot edit a converted quote.' };

    if (!data.lineItems || !data.lineItems.length) return { success: false, error: 'At least one line item is required.' };

    var client = getClientById(quote.clientId);
    if (!client) return { success: false, error: 'Client not found.' };

    var issueISO = data.issueDateISO || new Date().toISOString().split('T')[0];
    var validISO = data.validDateISO || _addDays(issueISO, 30);
    var lineItems = data.lineItems.map(function(i) {
      return { name: i.name || '', description: i.description || '', qty: i.qty || 1, price: i.price || 0 };
    });
    var subtotal = lineItems.reduce(function(s, i) { return s + i.qty * i.price; }, 0);
    var taxes    = parseFloat(data.tax || 0);

    var pdfData = {
      quoteId:       quote.quoteId,
      driveFolderId: client.driveFolderId || '',
      clientName:    client.name,
      clientStreet:  client.billingStreet  || '',
      clientCity:    client.billingCity    || '',
      clientState:   client.billingState   || '',
      clientZip:     client.billingZip     || '',
      clientCountry: client.billingCountry || '',
      clientPhone:   client.phone          || '',
      clientEmail:   client.billingEmail   || '',
      clientWebsite: client.website        || '',
      issueDate:     _formatDateForDoc(issueISO),
      validDate:     _formatDateForDoc(validISO),
      lineItems:     lineItems,
      subtotal:      subtotal,
      taxes:         taxes,
      total:         subtotal + taxes,
    };

    var pdfResult = regenerateQuotePdf(pdfData);
    if (!pdfResult.success) return pdfResult;

    // Trash the old PDF
    if (quote.driveLink) {
      try {
        var match = quote.driveLink.match(/\/d\/([a-zA-Z0-9_-]+)/);
        if (match) DriveApp.getFileById(match[1]).setTrashed(true);
      } catch (e) {
        Logger.log('panelEditQuote: could not trash old Drive file — ' + e.message);
      }
    }

    // Update the Notion record in-place
    updateQuoteRecord(quotePageId, {
      issueDateISO: issueISO,
      validDateISO: validISO,
      lineItems:    lineItems,
      subtotal:     subtotal,
      taxes:        taxes,
      total:        subtotal + taxes,
      driveUrl:     pdfResult.driveUrl,
      notes:        data.notes !== undefined ? data.notes : quote.notes,
      projectId:    data.projectId || quote.projectId || '',
    });

    _cacheInvalidate(_CACHE_KEYS);
    return { success: true, quoteId: quote.quoteId, url: pdfResult.driveUrl };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Expire the original quote and create a new revised quote.
 * @param {string} quotePageId - Notion page ID of the quote to expire.
 * @param {Object} data        - Same shape as panelCreateQuote data.
 */
function panelReviseQuote(quotePageId, data) {
  _requireRole(['admin', 'partner']);
  try {
    var original = getQuoteById(quotePageId);
    if (!original) return { success: false, error: 'Original quote not found.' };
    if (original.status === 'Converted') return { success: false, error: 'Cannot revise a converted quote.' };

    if (!data.clientId) return { success: false, error: 'Client is required.' };
    if (!data.lineItems || !data.lineItems.length) return { success: false, error: 'At least one line item is required.' };

    var client = getClientById(data.clientId);
    if (!client) return { success: false, error: 'Client not found.' };

    var issueISO = data.issueDateISO || new Date().toISOString().split('T')[0];
    var validISO = data.validDateISO || _addDays(issueISO, 30);
    var lineItems = data.lineItems.map(function(i) {
      return { name: i.name || '', description: i.description || '', qty: i.qty || 1, price: i.price || 0 };
    });
    var subtotal = lineItems.reduce(function(s, i) { return s + i.qty * i.price; }, 0);
    var taxes    = parseFloat(data.tax || 0);

    var quoteData = {
      clientId:      client.id,
      clientName:    client.name,
      driveFolderId: client.driveFolderId || '',
      clientStreet:  client.billingStreet  || '',
      clientCity:    client.billingCity    || '',
      clientState:   client.billingState   || '',
      clientZip:     client.billingZip     || '',
      clientCountry: client.billingCountry || '',
      clientPhone:   client.phone          || '',
      clientEmail:   client.billingEmail   || '',
      clientWebsite: client.website        || '',
      projectId:     data.projectId || '',
      issueDate:     _formatDateForDoc(issueISO),
      validDate:     _formatDateForDoc(validISO),
      issueDateISO:  issueISO,
      validDateISO:  validISO,
      lineItems:     lineItems,
      subtotal:      subtotal,
      taxes:         taxes,
      total:         subtotal + taxes,
      logToNotion:   true,
    };

    var result = generateQuote(quoteData);
    if (!result.success) return result;

    // Expire the original
    updateQuoteStatus(quotePageId, 'Expired');

    _cacheInvalidate(_CACHE_KEYS);
    return {
      success:    true,
      quoteId:    result.quoteId,
      url:        result.url,
      pageId:     result.pageId,
      expiredId:  original.quoteId,
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Convert an accepted quote into an invoice.
 * Generates the invoice PDF, logs it to Notion, and links the quote to the new invoice.
 * @param {string} quotePageId  Notion page ID of the quote.
 * @param {Object} invoiceData  { issueDateISO, dueDateISO, invoiceType, tax, lineItems? }
 */
function panelConvertQuoteToInvoice(quotePageId, invoiceData) {
  _requireRole(['admin', 'partner']);
  try {
    var quote = getQuoteById(quotePageId);
    if (!quote) return { success: false, error: 'Quote not found.' };
    if (quote.convertedInvoiceId) return { success: false, error: 'This quote has already been converted to an invoice.' };

    var client = quote.clientId ? getClientById(quote.clientId) : null;
    if (!client) return { success: false, error: 'Client not found.' };

    var issueISO = (invoiceData && invoiceData.issueDateISO) || new Date().toISOString().split('T')[0];
    var dueISO   = (invoiceData && invoiceData.dueDateISO)   || _addDays(issueISO, 14);

    // Use provided line items or fall back to quote line items summary as a single item
    var lineItems = (invoiceData && invoiceData.lineItems && invoiceData.lineItems.length)
      ? invoiceData.lineItems.map(function(i) {
          return { name: i.name || '', description: i.description || '', qty: i.qty || 1, price: i.price || 0 };
        })
      : [{ name: 'See Quote ' + quote.quoteId, description: '', qty: 1, price: quote.total }];

    var subtotal = lineItems.reduce(function(s, i) { return s + (i.qty || 1) * (i.price || 0); }, 0);
    var taxes    = parseFloat((invoiceData && invoiceData.tax) || quote.tax || 0);

    var inv = {
      clientId:      client.id,
      clientName:    client.name,
      driveFolderId: client.driveFolderId || '',
      clientStreet:  client.billingStreet  || '',
      clientCity:    client.billingCity    || '',
      clientState:   client.billingState   || '',
      clientZip:     client.billingZip     || '',
      clientCountry: client.billingCountry || '',
      clientPhone:   client.phone          || '',
      clientEmail:   client.billingEmail   || '',
      clientWebsite: client.website        || '',
      projectId:     (invoiceData && invoiceData.projectId) || quote.projectId || '',
      issueDate:     _formatDateForDoc(issueISO),
      dueDate:       _formatDateForDoc(dueISO),
      issueDateISO:  issueISO,
      dueDateISO:    dueISO,
      invoiceType:   (invoiceData && invoiceData.invoiceType) || 'Deposit',
      lineItems:     lineItems,
      subtotal:      subtotal,
      taxes:         taxes,
      total:         subtotal + taxes,
      exportPdf:     true,
      logToNotion:   true,
    };

    var result = generateInvoice(inv);
    if (!result.success) return result;

    // Link quote → invoice in Notion (non-fatal)
    try { linkQuoteToInvoice(quotePageId, result.pageId || ''); } catch (e) {
      Logger.log('linkQuoteToInvoice error: ' + e.message);
    }

    _cacheInvalidate(_CACHE_KEYS);
    return { success: true, invoiceId: result.invoiceId, invoiceUrl: result.url, quoteId: quote.quoteId };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Quick-create an invoice from the project detail page.
 * Fetches full client billing info server-side so the panel only
 * needs to send clientId, projectId, lineItems, dates, and tax.
 * Reuses the existing generateInvoice() + logToNotion() chain.
 * @param {Object} data  { clientId, projectId, invoiceType, lineItems, tax, issueDateISO, dueDateISO }
 * @returns {Object} { success, invoiceId, url, error? }
 */
/**
 * Get billable expenses for a client that haven't been invoiced yet.
 * Used by the invoice form to let users import billable expenses as line items.
 */
function getBillableExpensesForClient(clientId) {
  try {
    return { success: true, expenses: getUnInvoicedBillableExpenses(clientId) };
  } catch (e) {
    Logger.log('getBillableExpensesForClient error: ' + e.message);
    return { success: false, error: e.message, expenses: [] };
  }
}

function panelQuickCreateInvoice(data) {
  _requireRole(['admin', 'partner']);
  try {
    if (!data.clientId) return { success: false, error: 'Client ID is required.' };
    if (!data.lineItems || !data.lineItems.length) return { success: false, error: 'At least one line item is required.' };

    var client = getClientById(data.clientId);
    if (!client) return { success: false, error: 'Client not found.' };

    var issueISO = data.issueDateISO || new Date().toISOString().split('T')[0];
    var dueISO   = data.dueDateISO   || _addDays(issueISO, 14);
    var lineItems = data.lineItems.map(function(i) {
      return { name: i.name || '', description: i.description || '', qty: i.qty || 1, price: i.price || 0 };
    });
    var subtotal = lineItems.reduce(function(s, i) { return s + i.qty * i.price; }, 0);
    var taxes    = parseFloat(data.tax || 0);

    var invoiceData = {
      clientId:      client.id,
      clientName:    client.name,
      driveFolderId: client.driveFolderId || '',
      clientStreet:  client.billingStreet  || '',
      clientCity:    client.billingCity    || '',
      clientState:   client.billingState   || '',
      clientZip:     client.billingZip     || '',
      clientCountry: client.billingCountry || '',
      clientPhone:   client.phone          || '',
      clientEmail:   client.billingEmail   || '',
      clientWebsite: client.website        || '',
      projectId:     data.projectId || '',
      issueDate:     _formatDateForDoc(issueISO),
      dueDate:       _formatDateForDoc(dueISO),
      issueDateISO:  issueISO,
      dueDateISO:    dueISO,
      invoiceType:   data.invoiceType || 'Final',
      lineItems:     lineItems,
      subtotal:      subtotal,
      taxes:         taxes,
      total:         subtotal + taxes,
      exportPdf:     true,
      logToNotion:   true,
    };

    var result = generateInvoice(invoiceData);
    if (result.success) _cacheInvalidate(_CACHE_KEYS);
    return result;
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── SYSTEM HEALTH CHECK ──────────────────────────────────────

/**
 * Lightweight startup ping — verify Notion token is valid.
 * Called on page load; runs in parallel with dashboard render.
 * @returns {Object} { ok: boolean, error?: string }
 */
/**
 * Quick health check on panel load — checks critical systems only.
 * Cached for 24 hours so it doesn't slow down every page load.
 * Returns { ok: true } or { ok: false, issues: [...] }
 */
function panelQuickPing() {
  // Check cache first (24h TTL)
  var cache = CacheService.getScriptCache();
  var cached = cache.get('_healthCheckResult');
  if (cached) {
    try { return JSON.parse(cached); } catch (_) {}
  }

  var issues = [];

  // 1. Notion API token
  try {
    _notionGet('users/me');
  } catch (e) {
    issues.push('Notion API: ' + e.message);
  }

  // 2. Critical Drive folders
  var folders = [
    { id: CONFIG.CLIENTS_DRIVE_ROOT,   label: 'Clients Drive folder' },
    { id: CONFIG.FINANCIALS_DRIVE_DIR, label: 'Financials Drive folder' },
  ];
  folders.forEach(function(f) {
    try {
      if (f.id) DriveApp.getFolderById(f.id);
      else issues.push(f.label + ': not configured');
    } catch (e) {
      issues.push(f.label + ': not found or inaccessible');
    }
  });

  // 3. Notion databases accessible
  var dbs = [
    { id: CONFIG.NOTION_CLIENTS_DB,     label: 'Clients DB' },
    { id: CONFIG.NOTION_EXPENSES_DB,    label: 'Expenses DB' },
    { id: CONFIG.NOTION_INVOICES_DB,    label: 'Invoices DB' },
    { id: CONFIG.NOTION_PAYMENTS_DB,    label: 'Payments DB' },
    { id: CONFIG.NOTION_CONTRACTORS_DB, label: 'Contractors DB' },
    { id: CONFIG.NOTION_QUOTES_DB,      label: 'Quotes DB' },
  ];
  dbs.forEach(function(db) {
    try {
      if (db.id) _notionFetch('databases/' + db.id + '/query', { page_size: 1 });
      else issues.push(db.label + ': not configured');
    } catch (e) {
      issues.push(db.label + ': ' + e.message);
    }
  });

  // 4. Anthropic API key
  var anthropicKey = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!anthropicKey) {
    issues.push('Claude API key: not set — receipt extraction disabled');
  }

  var result = issues.length === 0
    ? { ok: true }
    : { ok: false, issues: issues };

  // Cache for 24 hours (86400 seconds)
  try { cache.put('_healthCheckResult', JSON.stringify(result), 86400); } catch (_) {}

  return result;
}

/**
 * Comprehensive health check of all external dependencies,
 * database schemas, configuration, and trigger status.
 * @returns {Object} { checks: Array<{name, status, message}>, timestamp }
 */
function panelHealthCheck() {
  _requireRole(['admin']);
  // Clear the quick ping cache so next page load gets fresh data
  try { CacheService.getScriptCache().remove('_healthCheckResult'); } catch (_) {}

  var checks = [];

  // ── 1. Notion API token ────────────────────────────────────
  try {
    var user = _notionGet('users/me');
    checks.push({ name: 'Notion API Token', status: 'ok', message: 'Connected as ' + (user.name || 'integration') });
  } catch (e) {
    checks.push({ name: 'Notion API Token', status: 'error', message: e.message });
  }

  // ── 2. Document templates ──────────────────────────────────
  try {
    var doc = DocumentApp.openById(CONFIG.TEMPLATE_ID);
    checks.push({ name: 'Invoice Template', status: 'ok', message: doc.getName() });
  } catch (e) {
    checks.push({ name: 'Invoice Template', status: 'error', message: 'Cannot open template: ' + e.message });
  }
  try {
    var qDoc = DocumentApp.openById(CONFIG.QUOTE_TEMPLATE_ID);
    checks.push({ name: 'Quote Template', status: 'ok', message: qDoc.getName() });
  } catch (e) {
    checks.push({ name: 'Quote Template', status: 'error', message: 'Cannot open template: ' + e.message });
  }

  // ── 3. Drive folders ───────────────────────────────────────
  var folders = [
    { id: CONFIG.CLIENTS_DRIVE_ROOT,  label: 'Drive: Clients Root' },
    { id: CONFIG.ASSETS_DRIVE_ROOT,   label: 'Drive: Assets Root' },
    { id: CONFIG.FINANCIALS_DRIVE_DIR, label: 'Drive: Financials' },
    { id: CONFIG.LEGAL_CONTRACTS_DIR, label: 'Drive: Legal Contracts' },
    { id: CONFIG.LEGAL_INVOICES_DIR,  label: 'Drive: Legal Invoices' },
  ];
  folders.forEach(function(f) {
    try {
      var folder = DriveApp.getFolderById(f.id);
      checks.push({ name: f.label, status: 'ok', message: folder.getName() });
    } catch (e) {
      checks.push({ name: f.label, status: 'error', message: 'Folder not found or inaccessible' });
    }
  });

  // ── 4. Notion databases + 5. Schema validation ────────────
  var dbChecks = [
    { id: CONFIG.NOTION_CLIENTS_DB,     label: 'Clients',     props: ['Name','Type','Status','Primary Contact','Billing Email','Phone','Website','Drive Folder ID','Notes'] },
    { id: CONFIG.NOTION_CONTACTS_DB,    label: 'Contacts',    props: ['Name','Email','Phone','Role','Client','Notes'] },
    { id: CONFIG.NOTION_PROJECTS_DB,    label: 'Projects',    props: ['Name','Client','Type','Status','Start Date','End Date','Notes'] },
    { id: CONFIG.NOTION_INVOICES_DB,    label: 'Invoices',    props: ['Invoice ID','Client','Project','Type','Status','Issued Date','Due Date','Subtotal','Tax','Total','Line Items','Google Drive Link','Period Month','Notes'] },
    { id: CONFIG.NOTION_AGREEMENTS_DB,  label: 'Agreements',  props: ['Title','Client','Project','Doc Type','Status','Effective Date','Signed Date','Notes'] },
    { id: CONFIG.NOTION_EXPENSES_DB,    label: 'Expenses',    props: ['Expense ID','Description','Category','Amount','Expense Date','Client','Project','Type','Contractor','Invoice','Billable','Receipt URL','Status','Notes'] },
    { id: CONFIG.NOTION_PAYMENTS_DB,    label: 'Payments',    props: ['Payment ID','Description','Invoice','Client','Amount','Method','Payment Date','Status','Receipt URL','Notes'] },
    { id: CONFIG.NOTION_CONTRACTORS_DB, label: 'Contractors', props: ['Name','Email','Phone','Type','Roles','Payment Method','Is Partner','W-9','Notes'] },
    { id: CONFIG.NOTION_QUOTES_DB,      label: 'Quotes',      props: ['Quote ID','Client','Project','Status','Issued Date','Valid Until','Subtotal','Tax','Total','Line Items','Google Drive Link','Converted Invoice','Notes'] },
  ];

  dbChecks.forEach(function(db) {
    // Database accessible?
    var props = _getDbProperties(db.id);
    if (props.error) {
      checks.push({ name: 'DB: ' + db.label, status: 'error', message: props.error });
      checks.push({ name: 'Schema: ' + db.label, status: 'error', message: 'Cannot validate — DB inaccessible' });
      return;
    }
    checks.push({ name: 'DB: ' + db.label, status: 'ok', message: props.length + ' properties' });

    // Schema check
    var missing = db.props.filter(function(p) { return props.indexOf(p) === -1; });
    if (missing.length) {
      checks.push({ name: 'Schema: ' + db.label, status: 'warn', message: 'Missing: ' + missing.join(', ') });
    } else {
      checks.push({ name: 'Schema: ' + db.label, status: 'ok', message: 'All expected properties present' });
    }

    Utilities.sleep(100); // Brief pause between DB checks
  });

  // ── 6. PropertiesService health ────────────────────────────
  var propKeys = [
    { key: 'settings_reminders', label: 'Settings: Reminders' },
    { key: 'backup_config',      label: 'Settings: Backup' },
    { key: 'recurring_configs',  label: 'Settings: Recurring Billing' },
    { key: 'reminder_log',       label: 'Data: Reminder Log' },
    { key: 'email_templates',    label: 'Data: Email Templates' },
  ];
  propKeys.forEach(function(pk) {
    try {
      var raw = PropertiesService.getScriptProperties().getProperty(pk.key);
      if (!raw) {
        checks.push({ name: pk.label, status: 'ok', message: 'Not set (using defaults)' });
        return;
      }
      var parsed = JSON.parse(raw);
      var size = raw.length;
      var detail = '';
      if (Array.isArray(parsed)) {
        detail = parsed.length + ' entries, ' + (size / 1024).toFixed(1) + ' KB';
      } else if (typeof parsed === 'object') {
        detail = Object.keys(parsed).length + ' keys, ' + (size / 1024).toFixed(1) + ' KB';
      }
      checks.push({ name: pk.label, status: 'ok', message: detail || (size / 1024).toFixed(1) + ' KB' });
    } catch (e) {
      checks.push({ name: pk.label, status: 'error', message: 'Malformed JSON: ' + e.message });
    }
  });

  // ── 7. Script Properties (API keys) ────────────────────────
  var apiKeys = [
    { key: 'PICKER_API_KEY',   label: 'API Key: Google Picker' },
    { key: 'PICKER_APP_ID',    label: 'API Key: Picker App ID' },
    { key: 'ANTHROPIC_API_KEY', label: 'API Key: Anthropic (Claude)' },
  ];
  var _sp = PropertiesService.getScriptProperties();
  apiKeys.forEach(function(ak) {
    var val = _sp.getProperty(ak.key);
    if (val) {
      checks.push({ name: ak.label, status: 'ok', message: 'Set (' + val.length + ' chars)' });
    } else {
      checks.push({ name: ak.label, status: 'warn', message: 'Not set — feature may not work' });
    }
  });

  // ── 8. Triggers ────────────────────────────────────────────
  try {
    var triggers = ScriptApp.getProjectTriggers();
    if (triggers.length === 0) {
      checks.push({ name: 'Triggers', status: 'warn', message: 'No triggers configured — reminders and recurring billing won\'t run automatically' });
    } else {
      var names = triggers.map(function(t) { return t.getHandlerFunction(); });
      checks.push({ name: 'Triggers', status: 'ok', message: triggers.length + ' active: ' + names.join(', ') });
    }
  } catch (e) {
    checks.push({ name: 'Triggers', status: 'warn', message: 'Cannot read triggers: ' + e.message });
  }

  return { checks: checks, timestamp: new Date().toISOString() };
}

// ── DAILY HEALTH CHECK EMAIL TRIGGER ──────────────────────────

/**
 * Time-driven trigger — run daily to email health check results.
 * Set up via Apps Script Triggers: dailyHealthCheckEmail, daily.
 * Only sends an email if there are warnings or errors.
 */
function dailyHealthCheckEmail() {
  try {
    // Invalidate the cached quick ping so next panel load gets fresh data
    try { CacheService.getScriptCache().remove('_healthCheckResult'); } catch (_) {}

    var result = panelHealthCheck();
    var checks = result.checks || [];

    var errors = checks.filter(function(c) { return c.status === 'error'; });
    var warnings = checks.filter(function(c) { return c.status === 'warn'; });
    var ok = checks.filter(function(c) { return c.status === 'ok'; });

    // Only send email if there are issues
    if (errors.length === 0 && warnings.length === 0) {
      Logger.log('dailyHealthCheckEmail: all ' + ok.length + ' checks passed — no email needed.');
      return;
    }

    // Build HTML email
    var html = '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">'
      + '<h2 style="color:#1a1a1a;border-bottom:2px solid #e5e0d8;padding-bottom:8px">RH Ops — Daily Health Check</h2>'
      + '<p style="color:#666;font-size:13px">' + new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) + '</p>';

    if (errors.length > 0) {
      html += '<h3 style="color:#dc2626;margin-top:20px">\u274C Errors (' + errors.length + ')</h3>'
        + '<table style="width:100%;border-collapse:collapse;font-size:13px">';
      errors.forEach(function(c) {
        html += '<tr><td style="padding:6px 8px;border-bottom:1px solid #eee;font-weight:600">' + c.name + '</td>'
          + '<td style="padding:6px 8px;border-bottom:1px solid #eee;color:#dc2626">' + c.message + '</td></tr>';
      });
      html += '</table>';
    }

    if (warnings.length > 0) {
      html += '<h3 style="color:#f59e0b;margin-top:20px">\u26A0\uFE0F Warnings (' + warnings.length + ')</h3>'
        + '<table style="width:100%;border-collapse:collapse;font-size:13px">';
      warnings.forEach(function(c) {
        html += '<tr><td style="padding:6px 8px;border-bottom:1px solid #eee;font-weight:600">' + c.name + '</td>'
          + '<td style="padding:6px 8px;border-bottom:1px solid #eee;color:#b45309">' + c.message + '</td></tr>';
      });
      html += '</table>';
    }

    html += '<h3 style="color:#16a34a;margin-top:20px">\u2705 Passing (' + ok.length + ')</h3>'
      + '<p style="font-size:12px;color:#999">' + ok.map(function(c) { return c.name; }).join(' &middot; ') + '</p>';

    html += '<hr style="border:none;border-top:1px solid #e5e0d8;margin-top:24px">'
      + '<p style="font-size:11px;color:#999;text-align:center">Sent automatically by RH Ops Panel &middot; '
      + '<a href="https://script.google.com" style="color:#999">Open Script Editor</a></p>'
      + '</div>';

    GmailApp.sendEmail(
      getCompanyInfo().email,
      'RH Ops Health Check — ' + errors.length + ' error(s), ' + warnings.length + ' warning(s)',
      'Health check found issues. View the HTML version of this email for details.',
      { htmlBody: html, name: 'RH Ops Panel' }
    );

    Logger.log('dailyHealthCheckEmail: sent — ' + errors.length + ' errors, ' + warnings.length + ' warnings.');
  } catch (e) {
    Logger.log('dailyHealthCheckEmail error: ' + e.message);
  }
}

// ── INVOICE REMINDERS TRIGGER ────────────────────────────────

/**
 * Time-driven trigger — run daily to send invoice reminders.
 * Set up via Apps Script Triggers: sendInvoiceReminders, daily.
 */
function sendInvoiceReminders() {
  var raw = PropertiesService.getScriptProperties().getProperty('settings_reminders');
  var settings = raw ? JSON.parse(raw) : _SETTINGS_DEFAULTS.reminders;
  if (!settings.enabled) { Logger.log('sendInvoiceReminders: disabled.'); return; }

  var invoices = getInvoicesByStatus(['Sent', 'Overdue']);
  if (invoices.error) { Logger.log('sendInvoiceReminders: ' + invoices.error); return; }

  var clients = getClients();
  if (clients.error) clients = [];
  var clientMap = {};
  clients.forEach(function(c) { clientMap[c.id] = c; });

  var logRaw = PropertiesService.getScriptProperties().getProperty('reminder_log');
  var reminderLog = logRaw ? JSON.parse(logRaw) : {};

  // Prune stale entries: remove log entries for invoices no longer Sent/Overdue
  var activeIds = {};
  invoices.forEach(function(inv) { activeIds[inv.id] = true; });
  var pruned = 0;
  Object.keys(reminderLog).forEach(function(invId) {
    if (!activeIds[invId]) { delete reminderLog[invId]; pruned++; }
  });
  if (pruned > 0) Logger.log('sendInvoiceReminders: pruned ' + pruned + ' stale log entries.');

  var today = new Date();
  var todayISO = today.toISOString().split('T')[0];
  var sent = 0;

  invoices.forEach(function(inv) {
    if (inv.status !== 'Sent' && inv.status !== 'Overdue') return;
    if (!inv.dueDate) return;
    var client = clientMap[inv.clientId];
    if (!client || !client.billingEmail) return;

    var due = new Date(inv.dueDate + 'T12:00:00');
    var daysUntilDue = Math.floor((due - today) / 86400000);
    var lastSent = reminderLog[inv.id] || '';
    if (lastSent === todayISO) return; // already sent today

    var shouldSend = false;
    var isOverdue = false;

    // Upcoming reminder
    if (inv.status === 'Sent' && daysUntilDue >= 0 && daysUntilDue <= settings.daysBefore) {
      shouldSend = true;
    }

    // Overdue reminders at configured intervals
    if (daysUntilDue < 0) {
      isOverdue = true;
      var daysOverdue = Math.abs(daysUntilDue);
      for (var i = 0; i < settings.overdueIntervals.length; i++) {
        if (daysOverdue === settings.overdueIntervals[i]) { shouldSend = true; break; }
      }
    }

    if (shouldSend) {
      try {
        sendInvoiceReminder({
          to: client.billingEmail,
          clientName: client.name,
          invoiceId: inv.invoiceId,
          total: inv.total,
          dueDate: inv.dueDate,
          isOverdue: isOverdue,
          driveLink: inv.driveLink || ''
        });
        reminderLog[inv.id] = todayISO;
        sent++;
      } catch (e) {
        Logger.log('Reminder failed for ' + inv.invoiceId + ': ' + e.message);
      }
    }
  });

  // Save updated log
  PropertiesService.getScriptProperties().setProperty('reminder_log', JSON.stringify(reminderLog));
  Logger.log('sendInvoiceReminders: sent ' + sent + ' reminders.');
}

// ── RECURRING INVOICES ───────────────────────────────────────

function panelGetRecurringConfig(projectId) {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty('recurring_configs');
    var all = raw ? JSON.parse(raw) : {};
    return all[projectId] || { enabled: false, amount: 0, description: '', dayOfMonth: 1, dueDays: 14 };
  } catch (e) {
    return { enabled: false, amount: 0, description: '', dayOfMonth: 1, dueDays: 14 };
  }
}

function panelSaveRecurringConfig(projectId, config) {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty('recurring_configs');
    var all = raw ? JSON.parse(raw) : {};
    all[projectId] = {
      enabled: !!config.enabled,
      amount: parseFloat(config.amount) || 0,
      description: (config.description || '').trim(),
      dayOfMonth: Math.min(28, Math.max(1, parseInt(config.dayOfMonth) || 1)),
      dueDays: Math.max(1, parseInt(config.dueDays) || 14)
    };
    PropertiesService.getScriptProperties().setProperty('recurring_configs', JSON.stringify(all));
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Time-driven trigger — run daily to generate recurring invoices.
 * Set up via Apps Script Triggers: generateRecurringInvoices, daily.
 */
function generateRecurringInvoices() {
  var raw = PropertiesService.getScriptProperties().getProperty('recurring_configs');
  var all = raw ? JSON.parse(raw) : {};
  var today = new Date();
  var dayOfMonth = today.getDate();
  var monthKey = today.toISOString().substring(0, 7); // e.g. 2026-03

  // Quick check: any configs for today? Skip lock acquisition on off-days.
  var hasWork = false;
  for (var pid in all) {
    if (all[pid].enabled && all[pid].dayOfMonth === dayOfMonth) { hasWork = true; break; }
  }
  if (!hasWork) { Logger.log('generateRecurringInvoices: no configs for day ' + dayOfMonth); return; }

  // Acquire lock to prevent overlap with concurrent invoice generation
  var lock = LockService.getScriptLock();
  try { lock.waitLock(15000); } catch (e) {
    Logger.log('generateRecurringInvoices: could not acquire lock \u2014 ' + e.message);
    return;
  }

  var generated = 0;
  try {

  for (var projectId in all) {
    var config = all[projectId];
    if (!config.enabled || config.dayOfMonth !== dayOfMonth) continue;
    if (!config.amount || !config.description) continue;

    try {
      var project = getProjectById(projectId);
      if (!project || project.status !== 'Active') continue;
      var client = project.clientId ? getClientById(project.clientId) : null;
      if (!client) continue;

      // Check if already generated this month
      var invoices = getInvoicesByProject(projectId);
      if (!invoices.error) {
        var alreadyGenerated = invoices.some(function(inv) {
          return (inv.issuedDate || '').substring(0, 7) === monthKey && inv.type === 'Retainer';
        });
        if (alreadyGenerated) continue;
      }

      var issueISO = today.toISOString().split('T')[0];
      var dueDate = _addDays(issueISO, config.dueDays || 14);

      var result = generateInvoice({
        clientId: client.id,
        clientName: client.name,
        driveFolderId: client.driveFolderId || '',
        clientStreet: client.billingStreet || '',
        clientCity: client.billingCity || '',
        clientState: client.billingState || '',
        clientZip: client.billingZip || '',
        clientCountry: client.billingCountry || '',
        clientPhone: client.phone || '',
        clientEmail: client.billingEmail || '',
        clientWebsite: client.website || '',
        projectId: projectId,
        issueDate: _formatDateForDoc(issueISO),
        dueDate: _formatDateForDoc(dueDate),
        issueDateISO: issueISO,
        dueDateISO: dueDate,
        invoiceType: 'Retainer',
        lineItems: [{ name: config.description, description: '', qty: 1, price: config.amount }],
        subtotal: config.amount,
        taxes: 0,
        total: config.amount,
        exportPdf: true,
        logToNotion: true,
      });

      if (result.success) {
        generated++;
        Logger.log('Recurring invoice generated: ' + result.invoiceId + ' for project ' + project.name);
      } else {
        Logger.log('Recurring invoice failed for project ' + project.name + ': ' + result.error);
      }
    } catch (e) {
      Logger.log('Recurring invoice error for ' + projectId + ': ' + e.message);
    }
  }

  if (generated > 0) _cacheInvalidate(_CACHE_KEYS);
  Logger.log('generateRecurringInvoices: generated ' + generated + ' invoices.');

  } finally {
    lock.releaseLock();
  }
}

// ── FINANCIAL DATA EXPORT ────────────────────────────────────

function panelExportFinancialData(startDate, endDate) {
  try {
    var clients = getClients();
    var projects = getProjects();
    // Push date filter to Notion instead of fetching all + filtering client-side
    var filteredInvoices = getInvoicesByDateRange(startDate, endDate);
    var filteredExpenses = getExpensesByDateRange(startDate, endDate);

    if (clients.error) clients = [];
    if (projects.error) projects = [];
    if (filteredInvoices.error) filteredInvoices = [];
    if (filteredExpenses.error) filteredExpenses = [];

    // Build lookup maps
    var clientMap = {};
    clients.forEach(function(c) { clientMap[c.id] = c.name; });
    var projectMap = {};
    projects.forEach(function(p) { projectMap[p.id] = { name: p.name, clientId: p.clientId }; });

    // Create spreadsheet
    var ss = SpreadsheetApp.create('Financial Export ' + startDate + ' to ' + endDate);

    // ── Summary sheet ──
    var summary = ss.getActiveSheet();
    summary.setName('Summary');
    var totalRevenue = 0, totalOutstanding = 0, totalExpenses = 0;
    filteredInvoices.forEach(function(inv) {
      if (inv.status === 'Paid') totalRevenue += inv.total;
      if (inv.status === 'Sent' || inv.status === 'Overdue') totalOutstanding += inv.total;
    });
    filteredExpenses.forEach(function(exp) { totalExpenses += exp.amount; });
    summary.getRange('A1:B6').setValues([
      ['Metric', 'Amount'],
      ['Total Revenue (Paid)', totalRevenue],
      ['Outstanding', totalOutstanding],
      ['Total Expenses', totalExpenses],
      ['Profit', totalRevenue - totalExpenses],
      ['Date Range', startDate + ' to ' + endDate]
    ]);
    summary.getRange('A1:B1').setFontWeight('bold');
    summary.getRange('B2:B5').setNumberFormat('$#,##0.00');

    // ── Invoices sheet ──
    var invSheet = ss.insertSheet('Invoices');
    var invRows = [['Invoice ID', 'Client', 'Project', 'Type', 'Status', 'Issued', 'Due', 'Paid', 'Total']];
    filteredInvoices.forEach(function(inv) {
      invRows.push([
        inv.invoiceId, clientMap[inv.clientId] || 'Unknown',
        projectMap[inv.projectId] ? projectMap[inv.projectId].name : 'Unknown',
        inv.type, inv.status, inv.issuedDate, inv.dueDate, inv.paidDate || '', inv.total
      ]);
    });
    invSheet.getRange(1, 1, invRows.length, 9).setValues(invRows);
    invSheet.getRange('A1:I1').setFontWeight('bold');
    invSheet.getRange(2, 9, Math.max(1, invRows.length - 1), 1).setNumberFormat('$#,##0.00');

    // ── Expenses sheet ──
    var expSheet = ss.insertSheet('Expenses');
    var expRows = [['Description', 'Category', 'Project', 'Vendor', 'Amount', 'Date', 'Billable']];
    filteredExpenses.forEach(function(exp) {
      expRows.push([
        exp.description, exp.category,
        projectMap[exp.projectId] ? projectMap[exp.projectId].name : 'Unknown',
        exp.vendor, exp.amount, exp.expenseDate, exp.billable ? 'Yes' : 'No'
      ]);
    });
    expSheet.getRange(1, 1, expRows.length, 7).setValues(expRows);
    expSheet.getRange('A1:G1').setFontWeight('bold');
    expSheet.getRange(2, 5, Math.max(1, expRows.length - 1), 1).setNumberFormat('$#,##0.00');

    // ── Revenue by Client sheet ──
    var rcSheet = ss.insertSheet('Revenue by Client');
    var rcMap = {};
    filteredInvoices.forEach(function(inv) {
      if (inv.status !== 'Paid') return;
      var cname = clientMap[inv.clientId] || 'Unknown';
      rcMap[cname] = (rcMap[cname] || 0) + inv.total;
    });
    var rcRows = [['Client', 'Revenue']];
    for (var cn in rcMap) rcRows.push([cn, rcMap[cn]]);
    rcSheet.getRange(1, 1, rcRows.length, 2).setValues(rcRows);
    rcSheet.getRange('A1:B1').setFontWeight('bold');
    rcSheet.getRange(2, 2, Math.max(1, rcRows.length - 1), 1).setNumberFormat('$#,##0.00');

    // ── Revenue by Project sheet ──
    var rpSheet = ss.insertSheet('Revenue by Project');
    var rpMap = {}, epMap = {};
    filteredInvoices.forEach(function(inv) {
      if (inv.status !== 'Paid') return;
      var pname = projectMap[inv.projectId] ? projectMap[inv.projectId].name : 'Unknown';
      rpMap[pname] = (rpMap[pname] || 0) + inv.total;
    });
    filteredExpenses.forEach(function(exp) {
      var pname = projectMap[exp.projectId] ? projectMap[exp.projectId].name : 'Unknown';
      epMap[pname] = (epMap[pname] || 0) + exp.amount;
    });
    var allProj = {};
    for (var k1 in rpMap) allProj[k1] = true;
    for (var k2 in epMap) allProj[k2] = true;
    var rpRows = [['Project', 'Revenue', 'Expenses', 'Profit']];
    for (var pn in allProj) rpRows.push([pn, rpMap[pn] || 0, epMap[pn] || 0, (rpMap[pn] || 0) - (epMap[pn] || 0)]);
    rpSheet.getRange(1, 1, rpRows.length, 4).setValues(rpRows);
    rpSheet.getRange('A1:D1').setFontWeight('bold');
    rpSheet.getRange(2, 2, Math.max(1, rpRows.length - 1), 3).setNumberFormat('$#,##0.00');

    return { success: true, sheetUrl: ss.getUrl(), sheetId: ss.getId() };
  } catch (e) {
    return { success: false, error: e.message };
  }
}


// ── Data Backup ──────────────────────────────────────────────

/**
 * Read the backup configuration from PropertiesService.
 * Returns defaults for any missing keys.
 * @returns {Object} { frequency, spreadsheetId, lastBackup }
 */
function panelGetBackupConfig() {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty('backup_config');
    var config = raw ? JSON.parse(raw) : {};
    var folderId = config.folderId || '';
    var folderName = '';
    if (folderId) {
      try { folderName = DriveApp.getFolderById(folderId).getName(); } catch (_) {}
    }
    return {
      frequency:     config.frequency     || _SETTINGS_DEFAULTS.backup.frequency,
      spreadsheetId: config.spreadsheetId || '',
      lastBackup:    config.lastBackup    || '',
      folderId:      folderId,
      folderName:    folderName,
    };
  } catch (e) {
    Logger.log('panelGetBackupConfig error: ' + e.message);
    return _SETTINGS_DEFAULTS.backup;
  }
}

/**
 * Save backup settings (frequency and Drive folder).
 * @param {Object} config  { frequency: 'daily'|'weekly'|'monthly', folderId: string }
 * @returns {Object} { success, folderName? }
 */
function panelSaveBackupConfig(config) {
  _requireRole(['admin']);
  try {
    var allowed = ['daily', 'weekly', 'monthly'];
    var freq = (config && config.frequency) ? config.frequency : 'weekly';
    if (allowed.indexOf(freq) === -1) freq = 'weekly';

    var raw = PropertiesService.getScriptProperties().getProperty('backup_config');
    var existing = raw ? JSON.parse(raw) : {};
    existing.frequency = freq;

    // Handle folder — accept a raw folder ID from Picker or direct input
    var folderId = (config && config.folderId) ? config.folderId.trim() : '';
    var folderName = '';
    if (folderId) {
      // Extract ID from a Drive URL if pasted directly
      var match = folderId.match(/\/folders\/([a-zA-Z0-9_-]+)/);
      if (match) folderId = match[1];
      // Validate the folder exists and is accessible
      try {
        var folder = DriveApp.getFolderById(folderId);
        folderName = folder.getName();
      } catch (e) {
        return { success: false, error: 'Could not access that Drive folder. Please check the URL or folder ID.' };
      }
    }
    existing.folderId = folderId;

    // If folder changed and a spreadsheet already exists, move it
    if (existing.spreadsheetId && folderId) {
      try {
        var file = DriveApp.getFileById(existing.spreadsheetId);
        var targetFolder = DriveApp.getFolderById(folderId);
        file.moveTo(targetFolder);
        Logger.log('panelSaveBackupConfig: moved backup spreadsheet to ' + folderName);
      } catch (e) {
        Logger.log('panelSaveBackupConfig: could not move spreadsheet — ' + e.message);
      }
    }

    PropertiesService.getScriptProperties().setProperty('backup_config', JSON.stringify(existing));
    return { success: true, folderName: folderName };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Manual backup trigger — always runs regardless of frequency.
 * @returns {Object} { success, sheetUrl, lastBackup, error? }
 */
function panelRunBackup() {
  _requireRole(['admin']);
  return backupNotionData(true);
}

/**
 * Back up all Notion data to a single Google Sheets spreadsheet.
 * Each sheet is overwritten; Google Sheets version history provides recovery.
 * When called from a time-driven trigger, respects the frequency setting.
 * @param {boolean} [forceRun=false]  If true, skip frequency check (manual trigger).
 * @returns {Object} { success, sheetUrl, lastBackup, error? }
 */
function backupNotionData(forceRun) {
  try {
    // ── Read config ──────────────────────────────────────────
    var raw = PropertiesService.getScriptProperties().getProperty('backup_config');
    var config = raw ? JSON.parse(raw) : {};
    var frequency     = config.frequency     || 'weekly';
    var spreadsheetId = config.spreadsheetId || '';
    var lastBackup    = config.lastBackup    || '';
    var folderId      = config.folderId      || '';

    // ── Frequency gate (skip for manual runs) ────────────────
    if (!forceRun && lastBackup) {
      var lastDate = new Date(lastBackup);
      var now = new Date();
      var daysSince = (now - lastDate) / (1000 * 60 * 60 * 24);
      var thresholds = { daily: 1, weekly: 7, monthly: 30 };
      if (daysSince < (thresholds[frequency] || 7)) {
        Logger.log('backupNotionData: skipped — last backup ' + daysSince.toFixed(1) + ' days ago (frequency: ' + frequency + ')');
        return { success: true, skipped: true, lastBackup: lastBackup };
      }
    }

    // ── Open or create spreadsheet ───────────────────────────
    var ss = null;
    if (spreadsheetId) {
      try {
        ss = SpreadsheetApp.openById(spreadsheetId);
      } catch (e) {
        Logger.log('backupNotionData: could not open spreadsheet ' + spreadsheetId + ' — creating new one.');
        ss = null;
      }
    }
    if (!ss) {
      ss = SpreadsheetApp.create('RH Ops — Notion Backup');
      spreadsheetId = ss.getId();
      if (folderId) {
        try {
          var targetFolder = DriveApp.getFolderById(folderId);
          DriveApp.getFileById(spreadsheetId).moveTo(targetFolder);
          Logger.log('backupNotionData: moved new spreadsheet to folder ' + folderId);
        } catch (e) {
          Logger.log('backupNotionData: could not move to folder — ' + e.message);
        }
      }
    }

    // ── Clear existing sheets (keep first) ───────────────────
    var existingSheets = ss.getSheets();
    for (var i = existingSheets.length - 1; i >= 1; i--) {
      ss.deleteSheet(existingSheets[i]);
    }

    // ── Lookup maps for human-readable relationship names ────
    var clientMap = {};
    var projectMap = {};

    // ── Table definitions: fetch → map → write incrementally ─
    var tables = [
      {
        name: 'Clients',
        headers: ['Page ID', 'Name', 'Type', 'Status', 'Primary Contact ID', 'Billing Email', 'Billing Street', 'Billing City', 'Billing State', 'Billing ZIP', 'Billing Country', 'Phone', 'Website', 'Drive Folder ID', 'Notes', 'Notion URL'],
        fetchFn: function() {
          var data = getClients();
          if (!data.error) data.forEach(function(c) { clientMap[c.id] = c.name; });
          return data;
        },
        mapFn: function(c) {
          return [c.id, c.name, c.type, c.status, c.primaryContactId, c.billingEmail, c.billingStreet, c.billingCity, c.billingState, c.billingZip, c.billingCountry, c.phone, c.website, c.driveFolderId, c.notes, c.notionUrl];
        },
        currencyCols: []
      },
      {
        name: 'Contacts',
        headers: ['Page ID', 'Name', 'Email', 'Phone', 'Role', 'Client IDs', 'Client Names', 'Notes', 'Notion URL'],
        fetchFn: function() { return getAllContacts(); },
        mapFn: function(c) {
          var clientNames = (c.clientIds || []).map(function(cid) { return clientMap[cid] || ''; }).join(', ');
          return [c.id, c.name, c.email, c.phone, c.role, (c.clientIds || []).join(', '), clientNames, c.notes, c.notionUrl];
        },
        currencyCols: []
      },
      {
        name: 'Projects',
        headers: ['Page ID', 'Name', 'Client ID', 'Client Name', 'Type', 'Status', 'Start Date', 'End Date', 'Notes', 'Notion URL'],
        fetchFn: function() {
          var data = getProjects();
          if (!data.error) data.forEach(function(p) { projectMap[p.id] = p.name; });
          return data;
        },
        mapFn: function(p) { return [p.id, p.name, p.clientId, clientMap[p.clientId] || '', p.type, p.status, p.startDate, p.endDate, p.notes, p.notionUrl]; },
        currencyCols: []
      },
      {
        name: 'Invoices',
        headers: ['Page ID', 'Invoice ID', 'Client ID', 'Client Name', 'Project ID', 'Project Name', 'Agreement ID', 'Type', 'Status', 'Issued', 'Due', 'Paid', 'Period Month', 'Subtotal', 'Tax', 'Total', 'Line Items', 'Drive Link', 'Notes', 'Notion URL'],
        fetchFn: function() { return getAllInvoices(); },
        mapFn: function(inv) { return [inv.id, inv.invoiceId, inv.clientId, clientMap[inv.clientId] || '', inv.projectId, projectMap[inv.projectId] || '', inv.agreementId, inv.type, inv.status, inv.issuedDate, inv.dueDate, inv.paidDate, inv.periodMonth, inv.subtotal, inv.tax, inv.total, inv.lineItems, inv.driveLink, inv.notes, inv.notionUrl]; },
        currencyCols: [14, 15, 16]
      },
      {
        name: 'Agreements',
        headers: ['Page ID', 'Title', 'Doc Type', 'Status', 'Client ID', 'Client Name', 'Project ID', 'Project Name', 'Effective Date', 'Signed Date', 'File URL', 'Notes', 'Notion URL'],
        fetchFn: function() { return getAllAgreements(); },
        mapFn: function(a) { return [a.id, a.title, a.docType, a.status, a.clientId, clientMap[a.clientId] || '', a.projectId, projectMap[a.projectId] || '', a.effectiveDate, a.signedDate, a.fileUrl, a.notes, a.notionUrl]; },
        currencyCols: []
      },
      {
        name: 'Expenses',
        headers: ['Page ID', 'Expense ID', 'Description', 'Type', 'Category', 'Client ID', 'Client Name', 'Project ID', 'Project Name', 'Contractor ID', 'Invoice ID', 'Amount', 'Date', 'Vendor', 'Billable', 'Status', 'Receipt URL', 'Notes', 'Notion URL'],
        fetchFn: function() { return getAllExpenses(); },
        mapFn: function(ex) { return [ex.id, ex.expenseId, ex.description, ex.type, ex.category, ex.clientId, clientMap[ex.clientId] || '', ex.projectId, projectMap[ex.projectId] || '', ex.contractorId, ex.invoiceId, ex.amount, ex.expenseDate, ex.vendor, ex.billable ? 'Yes' : 'No', ex.status, ex.receiptUrl, ex.notes, ex.notionUrl]; },
        currencyCols: [12]
      },
      {
        name: 'Payments',
        headers: ['Page ID', 'Payment ID', 'Description', 'Invoice ID', 'Client ID', 'Client Name', 'Amount', 'Method', 'Date', 'Status', 'Receipt URL', 'Notes', 'Notion URL'],
        fetchFn: function() { return getAllPayments(); },
        mapFn: function(pm) { return [pm.id, pm.paymentId, pm.description, pm.invoiceId, pm.clientId, clientMap[pm.clientId] || '', pm.amount, pm.method, pm.paymentDate, pm.status, pm.receiptUrl, pm.notes, pm.notionUrl]; },
        currencyCols: [7]
      },
      {
        name: 'Contractors',
        headers: ['Page ID', 'Name', 'Email', 'Phone', 'Type', 'Roles', 'Payment Method', 'Is Partner', 'W-9', 'Notes', 'Notion URL'],
        fetchFn: function() { return getAllContractors(); },
        mapFn: function(c) { return [c.id, c.name, c.email, c.phone, c.type, c.roles.join(', '), c.paymentMethod, c.isPartner ? 'Yes' : 'No', c.w9Url, c.notes, c.notionUrl]; },
        currencyCols: []
      },
      {
        name: 'Config',
        headers: ['Setting', 'Value'],
        fetchFn: function() {
          var rows = [];
          var _redact = function(v) { return v ? '\u25CF\u25CF\u25CF\u25CF\u25CF\u25CF' + v.slice(-3) : '(not set)'; };
          // Config.js values
          rows.push({ s: 'NOTION_TOKEN',         v: _redact(CONFIG.NOTION_TOKEN) });
          rows.push({ s: 'API_SECRET',            v: _redact(CONFIG.API_SECRET) });
          rows.push({ s: 'TEMPLATE_ID',           v: CONFIG.TEMPLATE_ID || '' });
          rows.push({ s: 'NOTION_CLIENTS_DB',     v: CONFIG.NOTION_CLIENTS_DB || '' });
          rows.push({ s: 'NOTION_CONTACTS_DB',    v: CONFIG.NOTION_CONTACTS_DB || '' });
          rows.push({ s: 'NOTION_PROJECTS_DB',    v: CONFIG.NOTION_PROJECTS_DB || '' });
          rows.push({ s: 'NOTION_AGREEMENTS_DB',  v: CONFIG.NOTION_AGREEMENTS_DB || '' });
          rows.push({ s: 'NOTION_INVOICES_DB',    v: CONFIG.NOTION_INVOICES_DB || '' });
          rows.push({ s: 'NOTION_EXPENSES_DB',    v: CONFIG.NOTION_EXPENSES_DB || '' });
          rows.push({ s: 'NOTION_PAYMENTS_DB',     v: CONFIG.NOTION_PAYMENTS_DB || '' });
          rows.push({ s: 'NOTION_CONTRACTORS_DB', v: CONFIG.NOTION_CONTRACTORS_DB || '' });
          rows.push({ s: 'NOTION_QUOTES_DB',      v: CONFIG.NOTION_QUOTES_DB      || '' });
          rows.push({ s: 'QUOTE_TEMPLATE_ID',     v: CONFIG.QUOTE_TEMPLATE_ID     || '' });
          rows.push({ s: 'CLIENTS_DRIVE_ROOT',    v: CONFIG.CLIENTS_DRIVE_ROOT || '' });
          rows.push({ s: 'ASSETS_DRIVE_ROOT',     v: CONFIG.ASSETS_DRIVE_ROOT || '' });
          rows.push({ s: 'FINANCIALS_DRIVE_DIR',  v: CONFIG.FINANCIALS_DRIVE_DIR || '' });
          rows.push({ s: 'LEGAL_CONTRACTS_DIR',   v: CONFIG.LEGAL_CONTRACTS_DIR || '' });
          rows.push({ s: 'LEGAL_INVOICES_DIR',    v: CONFIG.LEGAL_INVOICES_DIR || '' });
          rows.push({ s: '---', v: '--- Script Properties ---' });
          // Script Properties (sensitive values redacted)
          var _sp = PropertiesService.getScriptProperties();
          rows.push({ s: 'PICKER_API_KEY',    v: _redact(_sp.getProperty('PICKER_API_KEY')) });
          rows.push({ s: 'PICKER_APP_ID',     v: _sp.getProperty('PICKER_APP_ID') || '(not set)' });
          rows.push({ s: 'ANTHROPIC_API_KEY',  v: _redact(_sp.getProperty('ANTHROPIC_API_KEY')) });
          rows.push({ s: '---', v: '--- Stored Configs ---' });
          // Stored config values
          var propKeys = ['settings_reminders', 'backup_config', 'recurring_configs', 'reminder_log', 'email_templates'];
          propKeys.forEach(function(key) {
            var raw = PropertiesService.getScriptProperties().getProperty(key);
            if (!raw) { rows.push({ s: key, v: '(not set)' }); return; }
            try {
              var parsed = JSON.parse(raw);
              if (key === 'reminder_log') {
                rows.push({ s: key, v: Object.keys(parsed).length + ' entries, ' + (raw.length / 1024).toFixed(1) + ' KB' });
              } else if (key === 'email_templates' && Array.isArray(parsed)) {
                rows.push({ s: key, v: parsed.length + ' templates' });
              } else {
                rows.push({ s: key, v: raw.length > 500 ? raw.substring(0, 500) + '...' : raw });
              }
            } catch (e) {
              rows.push({ s: key, v: 'MALFORMED JSON: ' + raw.substring(0, 100) });
            }
          });
          return rows;
        },
        mapFn: function(r) { return [r.s, r.v]; },
        currencyCols: []
      }
    ];

    // ── Fetch-and-write each table incrementally ─────────────
    var backupLog = [];
    var warnings = [];
    var tablesOk = 0;
    var tablesErrored = 0;

    for (var t = 0; t < tables.length; t++) {
      var tbl = tables[t];
      var logEntry = { table: tbl.name, records: 0, status: 'OK', error: '' };

      // Fetch
      Logger.log('backupNotionData: fetching ' + tbl.name + '...');
      var records;
      try {
        records = tbl.fetchFn();
      } catch (e) {
        records = { error: e.message };
      }

      // Handle fetch errors
      var rows = [];
      if (records && records.error) {
        logEntry.status = 'ERROR';
        logEntry.error = records.error;
        warnings.push(tbl.name + ': ' + records.error);
        tablesErrored++;
        Logger.log('Backup: ' + tbl.name + ' error — ' + records.error);
      } else if (Array.isArray(records)) {
        var expectedCols = tbl.headers.length;
        var skipped = 0;
        rows = records.map(function(r, idx) {
          try {
            var row = tbl.mapFn(r);
            if (!Array.isArray(row) || row.length !== expectedCols) {
              Logger.log('Backup: ' + tbl.name + ' row ' + idx + ' has ' + (row ? row.length : 0) + ' cols, expected ' + expectedCols + '. Record ID: ' + (r.id || 'unknown'));
              skipped++;
              return null;
            }
            return row;
          } catch (mapErr) {
            Logger.log('Backup: ' + tbl.name + ' row ' + idx + ' mapFn error: ' + mapErr.message + '. Record ID: ' + (r.id || 'unknown'));
            skipped++;
            return null;
          }
        }).filter(function(r) { return r !== null; });
        logEntry.records = rows.length;
        if (skipped > 0) {
          var warn = tbl.name + ': ' + skipped + ' record(s) skipped due to mapping errors — check execution log';
          warnings.push(warn);
          logEntry.error = warn;
        }
        tablesOk++;
      } else {
        logEntry.status = 'ERROR';
        logEntry.error = 'Unexpected response';
        warnings.push(tbl.name + ': Unexpected response');
        tablesErrored++;
      }

      // Write sheet
      var sheet;
      if (t === 0) {
        sheet = ss.getSheets()[0];
        sheet.setName(tbl.name);
      } else {
        sheet = ss.insertSheet(tbl.name);
      }
      sheet.clear();

      var data = [tbl.headers].concat(rows);
      if (data.length > 0 && data[0].length > 0) {
        sheet.getRange(1, 1, data.length, data[0].length).setValues(data);
      }

      // Bold headers + currency formatting
      sheet.getRange(1, 1, 1, tbl.headers.length).setFontWeight('bold');
      if (tbl.currencyCols.length > 0 && data.length > 1) {
        tbl.currencyCols.forEach(function(col) {
          sheet.getRange(2, col, data.length - 1, 1).setNumberFormat('$#,##0.00');
        });
      }

      // Fixed column widths (much faster than autoResizeColumn per column)
      sheet.setColumnWidths(1, tbl.headers.length, 140);

      backupLog.push(logEntry);

      // Brief pause between tables to spread API usage
      if (t < tables.length - 1) Utilities.sleep(200);
    }

    // ── Write Backup Log sheet ───────────────────────────────
    var logSheet = ss.insertSheet('Backup Log');
    var timestamp = new Date().toISOString();
    var logData = [['Table', 'Records', 'Status', 'Error']];
    backupLog.forEach(function(entry) {
      logData.push([entry.table, entry.records, entry.status, entry.error]);
    });
    logData.push(['', '', '', '']);
    logData.push(['Backup completed', '', timestamp, tablesOk + ' of ' + tables.length + ' tables OK']);
    logSheet.getRange(1, 1, logData.length, 4).setValues(logData);
    logSheet.getRange(1, 1, 1, 4).setFontWeight('bold');
    logSheet.setColumnWidths(1, 4, 160);

    // ── Update config ────────────────────────────────────────
    config.spreadsheetId = spreadsheetId;
    config.lastBackup    = timestamp;
    config.frequency     = frequency;
    PropertiesService.getScriptProperties().setProperty('backup_config', JSON.stringify(config));

    Logger.log('backupNotionData: complete — ' + tablesOk + '/' + tables.length + ' tables OK — ' + ss.getUrl());
    return {
      success: true,
      sheetUrl: ss.getUrl(),
      lastBackup: timestamp,
      tablesOk: tablesOk,
      tablesErrored: tablesErrored,
      warnings: warnings
    };

  } catch (e) {
    Logger.log('backupNotionData error: ' + e.message);
    return { success: false, error: e.message };
  }
}
