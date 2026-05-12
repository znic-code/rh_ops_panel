// ── GMAIL SERVICE ────────────────────────────────────────────
// Email sending with Drive file attachments and template engine.

// ── DEFAULT EMAIL TEMPLATES ─────────────────────────────────
var _DEFAULT_EMAIL_TEMPLATES = [
  {
    id: 'default_invoice_send',
    name: 'Invoice',
    type: 'invoice',
    isDefault: true,
    subject: '{{documentType}} {{documentId}} \u2014 {{companyName}}',
    body: 'Hi {{clientName}},\n\nPlease find attached invoice {{documentId}} for ${{total}}.\n\nPayment is due by {{dueDate}}.\n\nPlease let us know if you have any questions.\n\nBest regards,\n{{companyName}}'
  },
  {
    id: 'default_agreement_send',
    name: 'Agreement',
    type: 'agreement',
    isDefault: true,
    subject: '{{documentType}} {{documentId}} \u2014 {{companyName}}',
    body: 'Hi {{clientName}},\n\nPlease find attached {{documentType}} {{documentId}}.\n\nPlease review and let us know if you have any questions.\n\nBest regards,\n{{companyName}}'
  },
  {
    id: 'default_reminder_upcoming',
    name: 'Reminder: Upcoming',
    type: 'reminder_upcoming',
    isDefault: true,
    subject: 'Reminder: Invoice {{invoiceId}} \u2014 Upcoming (${{total}})',
    body: 'Hi {{clientName}},\n\nThis is a courtesy reminder that invoice {{invoiceId}} for ${{total}} is due on {{dueDate}}.\n\n{{#driveLink}}You can view the invoice here: {{driveLink}}\n\n{{/driveLink}}Please let us know if you have any questions.\n\nBest regards,\n{{companyName}}\n{{companyEmail}}'
  },
  {
    id: 'default_reminder_overdue',
    name: 'Reminder: Overdue',
    type: 'reminder_overdue',
    isDefault: true,
    subject: 'Reminder: Invoice {{invoiceId}} \u2014 Overdue (${{total}})',
    body: 'Hi {{clientName}},\n\nThis is a friendly reminder that invoice {{invoiceId}} for ${{total}} was due on {{dueDate}} and is now past due.\n\nWe would appreciate prompt payment at your earliest convenience.\n\n{{#driveLink}}You can view the invoice here: {{driveLink}}\n\n{{/driveLink}}Please let us know if you have any questions.\n\nBest regards,\n{{companyName}}\n{{companyEmail}}'
  }
];

// ── TEMPLATE ENGINE ─────────────────────────────────────────

/**
 * Replace {{variable}} placeholders in a template string with actual values.
 * Supports conditional blocks: {{#var}}content{{/var}} — included only if var is truthy.
 *
 * @param {string} template  Template string with {{variable}} placeholders
 * @param {Object} variables Key-value map of variable names to values
 * @returns {string}
 */
function resolveTemplateVariables(template, variables) {
  if (!template) return '';
  var result = template;

  // Handle conditional blocks: {{#varName}}content{{/varName}}
  for (var key in variables) {
    var blockRegex = new RegExp('\\{\\{#' + key + '\\}\\}([\\s\\S]*?)\\{\\{/' + key + '\\}\\}', 'g');
    result = result.replace(blockRegex, variables[key] ? '$1' : '');
  }

  // Replace simple variables
  for (var key in variables) {
    var regex = new RegExp('\\{\\{' + key + '\\}\\}', 'g');
    result = result.replace(regex, variables[key] || '');
  }

  // Remove any remaining unresolved placeholders
  result = result.replace(/\{\{#?[a-zA-Z_]+\}\}/g, '');
  result = result.replace(/\{\{\/[a-zA-Z_]+\}\}/g, '');

  return result;
}

/**
 * Build a template variables map from document/company data.
 *
 * @param {Object} params  Document data
 * @returns {Object}  Variable name -> value map
 */
function buildTemplateVariables(params) {
  var todayFormatted = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  var co = getCompanyInfo(); // single read — avoids 4 separate Script Properties lookups

  return {
    // Contact / Client
    clientName:     params.clientName || '',
    clientEmail:    params.clientEmail || '',
    clientPhone:    params.clientPhone || '',
    clientWebsite:  params.clientWebsite || '',
    contactName:    params.contactName || params.clientName || '',
    contactRole:    params.contactRole || '',

    // Document
    documentId:     params.documentId || params.invoiceId || '',
    documentType:   params.documentType || '',
    projectName:    params.projectName || '',

    // Financials
    total:          params.total || '',
    balanceDue:     params.balanceDue || params.total || '',
    issueDate:      params.issueDate || '',
    dueDate:        params.dueDate || '',
    driveLink:      params.driveLink || '',

    // Dates
    todayDate:      todayFormatted,

    // Company
    companyName:    co.name,
    companyEmail:   co.email,
    companyAddress: co.address,
    companyPhone:   co.phone,
  };
}

/**
 * Get all email templates (defaults + custom) optionally filtered by type.
 *
 * @param {string} [filterType]  Optional type filter
 * @returns {Array}  Array of template objects
 */
function getEmailTemplates(filterType) {
  var customs = [];
  try {
    var raw = PropertiesService.getScriptProperties().getProperty('email_templates');
    customs = raw ? JSON.parse(raw) : [];
  } catch (e) { customs = []; }

  // Build lookup of custom templates by ID
  var customById = {};
  customs.forEach(function(t) { customById[t.id] = t; });

  // Merge: customized defaults override originals, keep isDefault flag
  var all = [];
  _DEFAULT_EMAIL_TEMPLATES.forEach(function(def) {
    if (customById[def.id]) {
      var merged = customById[def.id];
      merged.isDefault = true;
      merged.isCustomized = true;
      all.push(merged);
      delete customById[def.id];
    } else {
      all.push(def);
    }
  });

  // Add remaining custom (non-default) templates
  for (var id in customById) {
    all.push(customById[id]);
  }

  if (filterType) {
    all = all.filter(function(t) { return t.type === filterType; });
  }
  return all;
}

// ── CORE EMAIL FUNCTIONS ────────────────────────────────────

/**
 * Create a Gmail draft with a Drive file attached.
 *
 * @param {Object} params
 * @param {string} params.to           Recipient email
 * @param {string} params.subject      Email subject
 * @param {string} params.body         Plain-text email body
 * @param {string} [params.fileId]     Drive file ID to attach
 * @returns {Object} { success, draftSubject?, error? }
 */
function createEmailDraft(params) {
  try {
    var options = {};
    if (params.fileId) {
      var file = DriveApp.getFileById(params.fileId);
      options.attachments = [file.getBlob()];
    }

    GmailApp.createDraft(params.to, params.subject, params.body, options);

    return { success: true, draftSubject: params.subject };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Send an email immediately with a Drive file attached.
 *
 * @param {Object} params  Same as createEmailDraft
 * @returns {Object} { success, error? }
 */
function sendEmail(params) {
  try {
    var options = {};
    if (params.fileId) {
      var file = DriveApp.getFileById(params.fileId);
      options.attachments = [file.getBlob()];
    }

    GmailApp.sendEmail(params.to, params.subject, params.body, options);

    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Build a pre-filled document email draft (legacy — kept for backward compatibility).
 *
 * @param {Object} params
 * @param {string} params.fileId       Drive file ID
 * @param {string} params.clientEmail  Recipient email
 * @param {string} params.clientName   Client name
 * @param {string} params.documentId   Document ID
 * @param {string} params.documentType "Invoice" or "Agreement"
 * @param {string} [params.total]      Formatted total
 * @param {string} [params.dueDate]    Human-readable due date
 * @returns {Object} { success, draftSubject?, error? }
 */
function createDocumentDraft(params) {
  var templateType = params.documentType === 'Invoice' ? 'invoice' : 'agreement';
  var templates = getEmailTemplates(templateType);
  var template = templates[0]; // default

  var variables = buildTemplateVariables({
    clientName:   params.clientName,
    clientEmail:  params.clientEmail,
    documentId:   params.documentId,
    documentType: params.documentType,
    total:        params.total || '',
    dueDate:      params.dueDate || '',
  });

  var subject = resolveTemplateVariables(template.subject, variables);
  var body = resolveTemplateVariables(template.body, variables);

  return createEmailDraft({
    to:      params.clientEmail,
    subject: subject,
    body:    body,
    fileId:  params.fileId || '',
  });
}

/**
 * Send an invoice reminder email (upcoming or overdue).
 * Uses template engine — loads custom template if available, else default.
 *
 * @param {Object} params
 * @param {string} params.to           Recipient email
 * @param {string} params.clientName   Client name
 * @param {string} params.invoiceId    Invoice ID
 * @param {number} params.total        Invoice total
 * @param {string} params.dueDate      ISO due date
 * @param {boolean} params.isOverdue   Whether this is an overdue reminder
 * @param {string} [params.driveLink]  Drive URL for the invoice
 * @returns {Object} { success, error? }
 */
function sendInvoiceReminder(params) {
  var dueFormatted = params.dueDate;
  try {
    var d = new Date(params.dueDate + 'T12:00:00');
    dueFormatted = d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  } catch (_) {}

  var totalFormatted = parseFloat(params.total || 0).toFixed(2);
  var templateType = params.isOverdue ? 'reminder_overdue' : 'reminder_upcoming';

  // Prefer a custom template; fall back to default
  var templates = getEmailTemplates(templateType);
  var template = templates[0];
  for (var i = 0; i < templates.length; i++) {
    if (!templates[i].isDefault) { template = templates[i]; break; }
  }

  var variables = buildTemplateVariables({
    clientName:  params.clientName,
    invoiceId:   params.invoiceId,
    total:       totalFormatted,
    dueDate:     dueFormatted,
    driveLink:   params.driveLink || '',
  });

  var subject = resolveTemplateVariables(template.subject, variables);
  var body = resolveTemplateVariables(template.body, variables);

  return sendEmail({ to: params.to, subject: subject, body: body });
}
