// ── AGREEMENT GENERATION SERVICE ─────────────────────────────
// Generates Google Doc contracts from templates using {{PLACEHOLDER}} syntax.
// Manages agreement IDs, Drive folder resolution, and Notion lifecycle.

// ── Agency constants (always fixed) ─────────────────────────
var _AGR_AGENCY_REP_NAME     = 'Julián Cuevas Paniagua';
var _AGR_AGENCY_REP_TITLE    = 'Co-Founder & Creative Director';
var _AGR_AGENCY_REP_EMAIL    = 'hello@roadhazardsmedia.com';
var _AGR_AGENCY_CONTACT_PHONE = '(787) 607-4678';
var _AGR_AGENCY_NOTICE_ADDRESS = '763 Calle Vesta, San Juan, PR 00923';

var _MONTHS_EN = ['January','February','March','April','May','June','July','August','September','October','November','December'];
var _MONTHS_ES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];

// ── Date helpers ─────────────────────────────────────────────

/** Format ISO date → "Month DD, YYYY" (English). e.g. "May 5, 2026" */
function _formatDateEN(isoDate) {
  if (!isoDate) return '';
  var p = isoDate.split('-');
  return _MONTHS_EN[parseInt(p[1], 10) - 1] + ' ' + parseInt(p[2], 10) + ', ' + p[0];
}

/** Format ISO date → "D de mes de YYYY" (Spanish). e.g. "5 de mayo de 2026" */
function _formatDateES(isoDate) {
  if (!isoDate) return '';
  var p = isoDate.split('-');
  return parseInt(p[2], 10) + ' de ' + _MONTHS_ES[parseInt(p[1], 10) - 1] + ' de ' + p[0];
}

/** Format a number as "$X,XXX.XX USD". Safe for GAS environment. */
function _formatMoney(amount) {
  var num = parseFloat(amount || 0);
  var parts = num.toFixed(2).split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return '$' + parts.join('.') + ' USD';
}

// ── ID generation ────────────────────────────────────────────

/**
 * Get the next sequential agreement ID.
 * Format: RH-{TYPE}-{YY}-{MMDD}-{NN}
 * Uses LockService + ScriptProperties to prevent duplicate IDs.
 * @param {string} type  'MSA' | 'SOW'
 * @returns {string}
 */
function getNextAgreementId(type) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var now    = new Date();
    var yy     = String(now.getFullYear()).slice(-2);
    var mm     = String(now.getMonth() + 1).padStart(2, '0');
    var dd     = String(now.getDate()).padStart(2, '0');
    var prefix = 'RH-' + type + '-' + yy + '-' + mm + dd;

    var props   = PropertiesService.getScriptProperties();
    var lastKey = '_lastAgreementId_' + type;
    var last    = props.getProperty(lastKey) || '';
    var seq     = 1;

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

// ── Drive folder helpers ─────────────────────────────────────

/**
 * Resolve (or create) 03_Clients/{Client}/Contracts/{year}/ folder.
 * @param {string} clientDriveFolderId  Client root folder ID
 * @param {string} [year]               Defaults to current year
 * @returns {string|null}
 */
function resolveContractFolder(clientDriveFolderId, year) {
  if (!clientDriveFolderId) return null;
  var yr          = year || new Date().getFullYear().toString();
  var contractsId = resolveOrCreateSubfolder(clientDriveFolderId, 'Contracts');
  if (!contractsId) return null;
  return resolveOrCreateSubfolder(contractsId, yr);
}

/**
 * Resolve (or create) the Signed/ subfolder inside a Contracts/{year}/ folder.
 * @param {string} contractFolderId
 * @returns {string|null}
 */
function resolveSignedFolder(contractFolderId) {
  if (!contractFolderId) return null;
  return resolveOrCreateSubfolder(contractFolderId, 'Signed');
}

// ── Template resolution ──────────────────────────────────────

/**
 * Return the correct template doc ID for the given type + language.
 * @param {string} contractType  'MSA' | 'SOW (Retainer)' | 'SOW (Project)'
 * @param {string} language      'English' | 'Spanish'
 * @returns {string|null}
 */
function _resolveTemplateId(contractType, language) {
  var es = (language === 'Spanish');
  if (contractType === 'MSA')            return es ? CONFIG.CONTRACT_TEMPLATE_MSA_ES    : CONFIG.CONTRACT_TEMPLATE_MSA_EN;
  if (contractType === 'SOW (Retainer)') return es ? CONFIG.CONTRACT_TEMPLATE_SOW_RET_ES : CONFIG.CONTRACT_TEMPLATE_SOW_RET_EN;
  if (contractType === 'SOW (Project)')  return es ? CONFIG.CONTRACT_TEMPLATE_SOW_PROJ_ES: CONFIG.CONTRACT_TEMPLATE_SOW_PROJ_EN;
  return null;
}

/**
 * Build the Drive file name for an agreement.
 *
 * Convention:
 *   MSA : {ID} — {ClientName} {LANG}[.ext]
 *   SOW : {ID} — {ClientName} — {Title} {LANG}[.ext]
 *
 * @param {string}        contractId  e.g. 'RH-MSA-26-0512-01'
 * @param {Object|string} client      Client object (uses .name) or plain name string
 * @param {string}        title       User-supplied title (ignored for MSAs)
 * @param {string}        language    'English' | 'Spanish'  → 'EN' | 'ES'
 * @param {string}        [ext]       File extension without dot (e.g. 'pdf'). Omit for Google Docs.
 * @returns {string}
 */
function _buildAgreementFileName(contractId, client, title, language, ext) {
  var clientName = (typeof client === 'string' ? client : (client.shorthand || client.name || 'Client')).trim();
  var isMSA      = contractId.indexOf('-MSA-') !== -1;

  var name;
  if (isMSA) {
    // MSA: ID — ClientName
    name = contractId + ' — ' + clientName;
  } else {
    // SOW: ID — ClientName — Title
    var safeTitle = (title || '').trim();
    name = contractId + ' — ' + clientName + (safeTitle ? ' — ' + safeTitle : '');
  }

  return ext ? name + '.' + ext.toLowerCase() : name;
}

// ── Placeholder map ──────────────────────────────────────────

/**
 * Fill a bullet-list placeholder with one or more items.
 * The placeholder must live in a list-item (bullet) paragraph in the template.
 *
 *  - 0 items / blank → replaces with "N/A"
 *  - 1 item          → simple replaceText, preserves existing bullet formatting
 *  - 2+ items        → replaces text of first item in-place, then inserts new
 *                      ListItems (via insertListItem) with copied list attributes
 *                      so each item becomes a proper bullet point in the same list
 *
 * Must be called BEFORE the generic replaceText loop so the placeholder is
 * already gone when the loop runs (loop becomes a silent no-op for these keys).
 *
 * @param {GoogleAppsScript.Document.Body} body
 * @param {string} placeholder  Literal placeholder, e.g. '{{STRATEGY_LINE_ITEMS}}'
 * @param {string} raw          Raw multi-line textarea input from the form
 */
function _fillBulletItems(body, placeholder, raw) {
  var escaped = escapeRegex(placeholder);
  if (!raw || !raw.trim()) { body.replaceText(escaped, 'N/A'); return; }
  var items = raw.split('\n').map(function(l) { return l.trim(); }).filter(Boolean);
  if (items.length === 0) { body.replaceText(escaped, 'N/A'); return; }
  if (items.length === 1) { body.replaceText(escaped, items[0]); return; }

  // Locate the list-item paragraph that contains the placeholder
  var found = body.findText(escaped);
  if (!found) {
    // Placeholder absent in this template (e.g. MSA has no scope section) — no-op
    return;
  }

  var textEl   = found.getElement();
  var listItem = textEl.getParent();  // The template ListItem
  var idx      = body.getChildIndex(listItem);

  // Replace the placeholder text in the template list item with the first item
  textEl.asText().replaceText(escaped, items[0]);

  // For each additional item, insert a detached deep copy of the template list item.
  // listItem.copy() creates a detached clone with identical list membership, nesting
  // level, glyph type, and indentation. insertListItem requires a detached element —
  // passing the attached listItem directly throws "Element must be detached".
  for (var i = 1; i < items.length; i++) {
    var copy    = listItem.copy();                    // detached deep clone
    var newItem = body.insertListItem(idx + i, copy); // insert; returns the live element
    newItem.editAsText().setText(items[i]);
  }
}

/**
 * Build the complete {{PLACEHOLDER}} → value map for a contract.
 *
 * @param {Object}      data     Form submission data
 * @param {Object}      client   Mapped client record (from getClientById)
 * @param {Object|null} contact  Mapped primary contact (or null)
 * @param {string}      idMSA    MSA agreement ID string (new MSA's own ID, or parent MSA ID for SOWs)
 * @param {string}      idSOW    SOW agreement ID string (empty for MSA)
 * @returns {Object}  map of placeholder string → replacement value
 */
function _buildPlaceholderMap(data, client, contact, idMSA, idSOW) {
  var lang       = data.language === 'Spanish' ? 'es' : 'en';
  var formatDate = lang === 'es' ? _formatDateES : _formatDateEN;

  // Client identity
  var legalName   = client.name;  // Name IS the legal name
  var addrParts   = [client.billingStreet, client.billingCity, client.billingState, client.billingZip, client.billingCountry].filter(Boolean);
  var billingAddr = addrParts.join(', ');

  // Primary contact info
  var contactName  = contact ? contact.name  : '';
  var contactEmail = contact ? contact.email : (client.billingEmail || '');
  var contactPhone = contact ? contact.phone : (client.phone || '');

  return {
    '{{MSA_ID}}':    idMSA,
    '{{SOW_ID}}':    idSOW,
    '{{SOW_TITLE}}': data.title || '',

    // Agency rep (MSA parties table left column)
    '{{AGENCY_REP_NAME}}':    _AGR_AGENCY_REP_NAME,
    '{{AGENCY_REP_TITLE}}':   _AGR_AGENCY_REP_TITLE,
    '{{AGENCY_REP_EMAIL}}':   _AGR_AGENCY_REP_EMAIL,

    // Agency §2.1 contact
    '{{AGENCY_CONTACT_NAME}}':  _AGR_AGENCY_REP_NAME,
    '{{AGENCY_CONTACT_EMAIL}}': _AGR_AGENCY_REP_EMAIL,
    '{{AGENCY_CONTACT_PHONE}}': _AGR_AGENCY_CONTACT_PHONE,

    // Agency §2.2 notice
    '{{AGENCY_NOTICE_ATTN}}':    _AGR_AGENCY_REP_NAME,
    '{{AGENCY_NOTICE_ADDRESS}}': _AGR_AGENCY_NOTICE_ADDRESS,
    '{{AGENCY_NOTICE_EMAIL}}':   _AGR_AGENCY_REP_EMAIL,

    // Client identity
    '{{CLIENT_LEGAL_NAME}}':    legalName,

    // Client §2.1 contact
    '{{CLIENT_CONTACT_NAME}}':  contactName,
    '{{CLIENT_CONTACT_EMAIL}}': contactEmail,
    '{{CLIENT_CONTACT_PHONE}}': contactPhone,

    // Client §2.2 notice
    '{{CLIENT_NOTICE_ATTN}}':    contactName || legalName,
    '{{CLIENT_NOTICE_ADDRESS}}': billingAddr,
    '{{CLIENT_NOTICE_EMAIL}}':   contactEmail,

    // Dates
    '{{START_DATE}}': formatDate(data.effectiveDate || ''),
    '{{END_DATE}}':   formatDate(data.endDate   || ''),
    '{{DEADLINE}}':   formatDate(data.deadline  || ''),

    // §4 Scope (SOW) — these placeholders are filled by _fillBulletItems() before
    // the replaceText loop runs; the entries here are intentional no-ops kept
    // so the keys stay documented alongside the rest of the map.
    '{{STRATEGY_LINE_ITEMS}}':             '',
    '{{PRODUCTION_LINE_ITEMS}}':           '',
    '{{CONTENT_DELIVERABLES_LINE_ITEMS}}': '',

    // §7 Fees — SOW Retainer
    '{{MONTHLY_RETAINER}}':    data.monthlyRetainer    ? _formatMoney(data.monthlyRetainer)    : '',
    '{{INITIAL_INSTALLMENT}}': data.initialInstallment ? _formatMoney(data.initialInstallment) : '',
    '{{FINAL_INSTALLMENT}}':   data.finalInstallment   ? _formatMoney(data.finalInstallment)   : '',

    // §10 Term — SOW Retainer
    '{{INITIAL_TERM_MONTHS}}': data.initialTermMonths ? String(data.initialTermMonths) : '3',
    '{{RENEWAL_TERM_MONTHS}}': data.renewalTermMonths ? String(data.renewalTermMonths) : '9',

    // §7 Fees — SOW Project
    '{{PROJECT_FEE}}':             data.projectFee         ? _formatMoney(data.projectFee)         : '',
    '{{BOOKING_FEE_AMOUNT}}':      data.bookingFee         ? _formatMoney(data.bookingFee)          : '',
    '{{FINAL_PAYMENT_AMOUNT}}':    data.finalPayment       ? _formatMoney(data.finalPayment)        : '',
    '{{MILESTONE_THRESHOLD}}':     data.milestoneThreshold ? '$' + parseFloat(data.milestoneThreshold).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : '$10,000',

    // §6 Operational overrides (SOW — blank = use MSA default)
    '{{APPROVAL_WINDOW}}':     data.approvalWindow     || '',
    '{{PROD_LEAD_TIME}}':      data.prodLeadTime       || '',
    '{{SCHED_CHANGE_WINDOW}}': data.schedChangeWindow  || '',
    '{{REVISION_ROUNDS}}':     data.revisionRounds     || '',
    '{{ACCEPT_WINDOW}}':       data.acceptWindow       || '',
    '{{FILE_RETENTION}}':      data.fileRetention      || '',
    '{{LATE_PAY_FEE}}':        data.latePayFee         || '',
    '{{CLAIM_PERIOD}}':        data.claimPeriod        || '',

    // MSA numeric defaults
    '{{APPROVAL_WINDOW_BUSINESS_DAYS}}':         String(data.approvalWindowDays    || 5),
    '{{LEAD_WINDOW_BUSINESS_DAYS}}':             String(data.leadWindowDays        || 10),
    '{{SCHEDULE_CHANGE_WINDOW_BUSINESS_DAYS}}':  String(data.schedChangeWindowDays || 7),
    '{{REVISIONS}}':                             String(data.revisions             || 2),
    '{{ACCEPTANCE_WINDOW_BUSINESS_DAYS}}':       String(data.acceptanceWindowDays  || 7),
    '{{FILE_RETENTION_DAYS}}':                   String(data.fileRetentionDays     || 90),
    '{{MONTHLY_LATE_FEE_PERCENT}}':              String(data.monthlyLateFeePercent || '2.5'),
    '{{WARRANTY_PERIOD_DAYS}}':                  String(data.warrantyPeriodDays    || 60),
  };
}

// ── Main generation function ─────────────────────────────────

/**
 * Generate a contract document from a template.
 *
 * Copies the template, fills all {{PLACEHOLDER}} values, creates a Notion entry.
 *
 * @param {Object} data
 *   contractType   {string}  'MSA' | 'SOW (Retainer)' | 'SOW (Project)'
 *   language       {string}  'English' | 'Spanish'
 *   clientId       {string}  Notion client page ID
 *   title          {string}  Short doc title (used in filename + SOW_TITLE)
 *   effectiveDate  {string}  ISO date (= Start Date for SOWs)
 *
 *   SOW only:
 *     parentMsaId  {string}  Notion agreement ID of parent MSA (optional)
 *     endDate      {string}  ISO date (SOW Retainer service end date)
 *     deadline     {string}  ISO date (SOW Project deadline)
 *     strategyItems     {string}  Scope §4.1, one item per line
 *     productionItems   {string}  Scope §4.2
 *     contentItems      {string}  Scope §4.3
 *     monthlyRetainer, initialInstallment, finalInstallment  (Retainer fees)
 *     projectFee, bookingFee, finalPayment                   (Project fees)
 *     initialTermMonths, renewalTermMonths                   (Retainer term)
 *
 *   Optional overrides (all default to blank/standard):
 *     approvalWindow, prodLeadTime, schedChangeWindow, revisionRounds,
 *     acceptWindow, fileRetention, latePayFee, claimPeriod             (SOW)
 *     approvalWindowDays, leadWindowDays, schedChangeWindowDays,
 *     revisions, acceptanceWindowDays, fileRetentionDays,
 *     monthlyLateFeePercent, warrantyPeriodDays                        (MSA)
 *
 *   Optional:
 *     projectId   {string}  Notion project page ID
 *     notes       {string}
 *
 * @returns {{ success, contractId?, notionId?, driveUrl?, notionUrl?, error? }}
 */
function generateAgreement(data) {

  // ── 1. Validate ───────────────────────────────────────────
  if (!data.contractType)               return { success: false, error: 'Contract type is required.' };
  if (!data.language)                   return { success: false, error: 'Language is required.' };
  if (!data.clientId)                   return { success: false, error: 'Client is required.' };
  if (!data.title || !data.title.trim()) return { success: false, error: 'Title is required.' };
  // Effective date is optional for MSAs (value isn't known until client signs)
  var isMSACheck = data.contractType === 'MSA';
  if (!data.effectiveDate && !isMSACheck) return { success: false, error: 'Effective date is required.' };

  var validTypes = ['MSA', 'SOW (Retainer)', 'SOW (Project)'];
  if (validTypes.indexOf(data.contractType) === -1)
    return { success: false, error: 'Invalid contract type.' };

  var validLangs = ['English', 'Spanish'];
  if (validLangs.indexOf(data.language) === -1)
    return { success: false, error: 'Language must be English or Spanish.' };

  var isMSA      = data.contractType === 'MSA';
  var isRetainer = data.contractType === 'SOW (Retainer)';
  var isProject  = data.contractType === 'SOW (Project)';

  if (isRetainer) {
    if (!data.endDate) return { success: false, error: 'End Date is required for a Retainer SOW.' };
    if (!data.monthlyRetainer || parseFloat(data.monthlyRetainer) <= 0)
      return { success: false, error: 'Monthly Retainer must be greater than zero.' };
  }
  if (isProject) {
    if (!data.deadline) return { success: false, error: 'Deadline is required for a Project SOW.' };
    if (!data.projectFee || parseFloat(data.projectFee) <= 0)
      return { success: false, error: 'Project Fee must be greater than zero.' };
  }

  // ── 2. Fetch client + contact ─────────────────────────────
  var client = getClientById(data.clientId);
  if (!client || client.error) return { success: false, error: 'Client not found.' };

  var contact = null;
  if (client.primaryContactId) {
    try { contact = getContactById(client.primaryContactId); } catch (e) { /* leave null */ }
  }

  // ── 3. Resolve parent MSA ID string (for SOWs) ───────────
  var idMSA          = '';
  var parentMsaPageId = '';
  if (!isMSA && data.parentMsaId) {
    parentMsaPageId = data.parentMsaId;
    try {
      var parentRaw = _notionGet('pages/' + data.parentMsaId);
      var parentAg  = _mapAgreementProperties(parentRaw);
      idMSA = parentAg.agreementId || parentAg.title || '';
    } catch (e) {
      Logger.log('generateAgreement: could not fetch parent MSA — ' + e.message);
    }
  }

  // ── 4. Generate contract ID ───────────────────────────────
  var idType    = isMSA ? 'MSA' : 'SOW';
  var contractId = getNextAgreementId(idType);
  if (isMSA)  idMSA = contractId;
  var idSOW     = isMSA ? '' : contractId;

  // ── 5. Resolve Drive folder ───────────────────────────────
  // Fall back to current year when no effective date is set (e.g. MSA pre-signing)
  var year = (data.effectiveDate || '').substring(0, 4) || new Date().getFullYear().toString();
  var contractFolderId = resolveContractFolder(client.driveFolderId, year);
  if (!contractFolderId) {
    // Fallback: use the central contracts directory
    contractFolderId = CONFIG.LEGAL_CONTRACTS_DIR;
    Logger.log('generateAgreement: no client Drive folder; using LEGAL_CONTRACTS_DIR');
  }

  // ── 6. Determine template ─────────────────────────────────
  var templateId = _resolveTemplateId(data.contractType, data.language);
  if (!templateId) return { success: false, error: 'Template not found for: ' + data.contractType };

  var fileName = _buildAgreementFileName(contractId, client, data.title.trim(), data.language);

  // ── 7. Copy template → Drive ──────────────────────────────
  var docId, docUrl;
  try {
    var templateFile   = DriveApp.getFileById(templateId);
    var targetFolder   = DriveApp.getFolderById(contractFolderId);
    var newDoc         = templateFile.makeCopy(fileName, targetFolder);
    docId  = newDoc.getId();
    docUrl = newDoc.getUrl();
  } catch (e) {
    return { success: false, error: 'Drive copy failed: ' + e.message };
  }

  // ── 8. Fill placeholders ──────────────────────────────────
  try {
    var placeholders = _buildPlaceholderMap(data, client, contact, idMSA, idSOW);
    var doc  = DocumentApp.openById(docId);
    var body = doc.getBody();

    // Bullet-list placeholders must be handled with element-level DOM manipulation
    // so that each item becomes a proper list paragraph (not a plain "- text" line).
    // These run first; the generic loop below becomes a silent no-op for these keys.
    _fillBulletItems(body, '{{STRATEGY_LINE_ITEMS}}',             data.strategyItems   || '');
    _fillBulletItems(body, '{{PRODUCTION_LINE_ITEMS}}',           data.productionItems || '');
    _fillBulletItems(body, '{{CONTENT_DELIVERABLES_LINE_ITEMS}}', data.contentItems    || '');

    for (var key in placeholders) {
      body.replaceText(escapeRegex(key), placeholders[key]);
    }
    doc.saveAndClose();
  } catch (e) {
    // Placeholder fill failed — trash the unfilled doc so it can't be mistaken
    // for a valid contract, then surface the error to the caller.
    Logger.log('generateAgreement: placeholder fill error — ' + e.message + ' — trashing ' + docId);
    try { DriveApp.getFileById(docId).setTrashed(true); } catch (_) {}
    return { success: false, error: 'Failed to fill contract placeholders: ' + e.message };
  }

  // ── 9. Create Notion entry ────────────────────────────────
  var notionTitle = contractId + ' — ' + data.title.trim();
  var notionPage;
  try {
    notionPage = createNotionAgreement({
      title:         notionTitle,
      docType:       data.contractType,
      status:        'Draft',
      clientId:      data.clientId,
      projectId:     data.projectId || '',
      effectiveDate: data.effectiveDate,
      fileUrl:       docUrl,
      notes:         data.notes || '',
      agreementId:   contractId,
      language:      data.language,
      parentMsaId:   parentMsaPageId,
    });
  } catch (e) {
    // Notion creation failed — return drive URL anyway so doc isn't orphaned
    return {
      success:  true,
      contractId: contractId,
      driveUrl:   docUrl,
      notionId:   '',
      notionUrl:  '',
      warning:    'Document created in Drive but Notion entry failed: ' + e.message,
    };
  }

  return {
    success:    true,
    contractId: contractId,
    notionId:   notionPage.id,
    driveUrl:   docUrl,
    notionUrl:  notionPage.url || '',
  };
}

// ── Upload Agreement (externally-created contracts) ──────────

/**
 * Upload a contract file to the Drive staging folder and run AI extraction.
 * Mirrors processReceiptStaged() in ReceiptService.js.
 *
 * @param {string} base64Data  Base64-encoded file content
 * @param {string} fileName    Original file name
 * @param {string} mimeType    MIME type (application/pdf, image/*, etc.)
 * @returns {{ success, fileId?, fileUrl?, fileName?, extracted?, extractionError?, error? }}
 */
function processAgreementStaged(base64Data, fileName, mimeType) {
  try {
    var stagingId = resolveOrCreateSubfolder(CONFIG.FINANCIALS_DRIVE_DIR, '_Staging');
    if (!stagingId) return { success: false, error: 'Could not resolve staging folder in Drive.' };

    var upload     = uploadFileToDrive(base64Data, fileName, mimeType, stagingId);
    var extraction = extractReceiptData(upload.fileId, 'agreement');

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
    Logger.log('processAgreementStaged error: ' + e.message);
    return { success: false, error: 'Agreement upload failed: ' + e.message };
  }
}

/**
 * Move a staged agreement file to its final Drive location and rename it.
 * Destination: 03_Clients/{Client}/Contracts/{year}/ (or LEGAL_CONTRACTS_DIR/{year}/ as fallback).
 * Final name follows the shared _buildAgreementFileName convention.
 *
 * @param {string}      fileId              Staged Drive file ID
 * @param {string|null} clientDriveFolderId Client root Drive folder (or null)
 * @param {string}      agreementId         Generated or user-supplied agreement ID
 * @param {string}      clientName          Client display name
 * @param {string}      title               Agreement title (used for SOWs; ignored for MSAs)
 * @param {string}      language            'English' | 'Spanish'
 * @returns {{ fileId: string, fileUrl: string }}
 */
function _moveAgreementToFinalFolder(fileId, clientDriveFolderId, agreementId, clientName, title, language) {
  var year = String(new Date().getFullYear());

  var folderId;
  if (clientDriveFolderId) {
    var contractsId = resolveOrCreateSubfolder(clientDriveFolderId, 'Contracts');
    folderId        = resolveOrCreateSubfolder(contractsId, year);
  } else {
    folderId = resolveOrCreateSubfolder(CONFIG.LEGAL_CONTRACTS_DIR, year);
  }
  if (!folderId) throw new Error('Could not resolve or create the Contracts folder in Drive.');

  var file     = DriveApp.getFileById(fileId);
  var origName = file.getName();
  var ext      = origName.indexOf('.') !== -1 ? origName.split('.').pop().toLowerCase() : 'pdf';
  var name     = _buildAgreementFileName(agreementId, clientName, title, language, ext);

  file.setName(name);
  file.moveTo(DriveApp.getFolderById(folderId));
  return { fileId: fileId, fileUrl: file.getUrl() };
}
