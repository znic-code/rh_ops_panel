// ── NOTION API ───────────────────────────────────────────────
// All functions that interact with the Notion API.
// This is the central data-access layer — service files call these.
//
// Property names are referenced via the NP (Notion Properties) constants
// defined in Config.js. Never use inline string literals for property names —
// always use NP.<DB>.<PROP>. This way a Notion property rename only requires
// changing one line in Config.js.

// ── Internal helpers ─────────────────────────────────────────

/**
 * Centralized HTTP request with error handling and retry.
 * Throws on any API error (non-2xx or Notion error object).
 * Retries up to 3 times on 429 (rate limited) and transient 5xx errors
 * with exponential backoff (500ms, 1s, 2s).
 */
function _notionRequest(url, options) {
  var MAX_RETRIES = 3;
  var RETRYABLE = [429, 500, 502, 503, 504];

  for (var attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    var res = UrlFetchApp.fetch(url, Object.assign({}, options, { muteHttpExceptions: true }));
    var code = res.getResponseCode();

    // Parse JSON — retry on truncated responses
    var body;
    try {
      body = JSON.parse(res.getContentText());
    } catch (parseErr) {
      if (attempt < MAX_RETRIES) {
        Logger.log('Notion: JSON parse error (attempt ' + (attempt + 1) + '): ' + parseErr.message);
        Utilities.sleep(Math.pow(2, attempt) * 500);
        continue;
      }
      throw new Error('Notion: Invalid JSON response after ' + (MAX_RETRIES + 1) + ' attempts — ' + parseErr.message);
    }

    // Retryable status — exponential backoff
    if (RETRYABLE.indexOf(code) !== -1) {
      if (attempt < MAX_RETRIES) {
        Utilities.sleep(Math.pow(2, attempt) * 500); // 500ms, 1s, 2s
        continue;
      }
      throw new Error('Notion: ' + (code === 429 ? 'Rate limited' : 'Server error ' + code) +
        ' after ' + (MAX_RETRIES + 1) + ' attempts');
    }

    // Non-retryable API error — throw with useful message
    if (code >= 400 || body.object === 'error') {
      throw new Error('Notion: ' + (body.message || 'Request failed') + ' (' + (body.code || code) + ')');
    }

    return body;
  }
}

/**
 * Authenticated POST request to the Notion API. Throws on error.
 */
function _notionFetch(endpoint, payload) {
  return _notionRequest('https://api.notion.com/v1/' + endpoint, {
    method: 'post',
    headers: {
      'Authorization':  'Bearer ' + CONFIG.NOTION_TOKEN,
      'Notion-Version': '2022-06-28',
      'Content-Type':   'application/json',
    },
    payload: JSON.stringify(payload),
  });
}

/**
 * Authenticated PATCH request to the Notion API. Throws on error.
 */
function _notionPatch(endpoint, payload) {
  return _notionRequest('https://api.notion.com/v1/' + endpoint, {
    method: 'patch',
    headers: {
      'Authorization':  'Bearer ' + CONFIG.NOTION_TOKEN,
      'Notion-Version': '2022-06-28',
      'Content-Type':   'application/json',
    },
    payload: JSON.stringify(payload),
  });
}

/**
 * Authenticated GET request to the Notion API. Throws on error.
 */
function _notionGet(endpoint) {
  return _notionRequest('https://api.notion.com/v1/' + endpoint, {
    method: 'get',
    headers: {
      'Authorization':  'Bearer ' + CONFIG.NOTION_TOKEN,
      'Notion-Version': '2022-06-28',
    },
  });
}

/**
 * Execute multiple Notion API requests in parallel via UrlFetchApp.fetchAll().
 * Returns an array of parsed JSON bodies in the same order as input specs.
 * Failed requests return { error: message } instead of throwing.
 *
 * @param {Array<Object>} specs  Each: { method, endpoint, payload? }
 * @returns {Array<Object>}
 */
function _notionBatchRequest(specs) {
  var requests = specs.map(function(spec) {
    var opts = {
      url: 'https://api.notion.com/v1/' + spec.endpoint,
      method: spec.method || 'get',
      headers: {
        'Authorization':  'Bearer ' + CONFIG.NOTION_TOKEN,
        'Notion-Version': '2022-06-28',
      },
      muteHttpExceptions: true,
    };
    if (spec.payload) {
      opts.headers['Content-Type'] = 'application/json';
      opts.payload = JSON.stringify(spec.payload);
    }
    return opts;
  });

  var responses = UrlFetchApp.fetchAll(requests);
  return responses.map(function(res, i) {
    try {
      var code = res.getResponseCode();
      var body = JSON.parse(res.getContentText());
      if (code >= 400 || body.object === 'error') {
        return { error: 'Notion: ' + (body.message || 'Request failed') + ' (' + (body.code || code) + ')' };
      }
      return body;
    } catch (e) {
      return { error: 'Parse error for request ' + i + ': ' + e.message };
    }
  });
}

/**
 * Map a batch query response through a property mapper.
 * Handles pagination follow-up sequentially if the first page had has_more.
 *
 * @param {Object} batchResult  Raw response from _notionBatchRequest (a database query)
 * @param {Function} mapper     Property mapper (e.g., _mapContactProperties)
 * @param {string} databaseId   For pagination follow-up
 * @param {Object} filter       Original filter
 * @param {Array} sorts         Original sorts
 * @returns {Array}
 */
function _parseBatchQueryResult(batchResult, mapper, databaseId, filter, sorts) {
  if (!batchResult || batchResult.error) {
    if (batchResult && batchResult.error) Logger.log('Batch query error: ' + batchResult.error);
    return [];
  }
  if (!batchResult.results) return [];

  var mapped = batchResult.results.map(mapper);

  // Paginate sequentially if more pages exist (rare for detail views)
  if (batchResult.has_more && batchResult.next_cursor) {
    var cursor = batchResult.next_cursor;
    while (cursor) {
      try {
        var body = { page_size: 100, start_cursor: cursor };
        if (filter) body.filter = filter;
        if (sorts)  body.sorts  = sorts;
        var data = _notionFetch('databases/' + databaseId + '/query', body);
        if (data.results) mapped.push.apply(mapped, data.results.map(mapper));
        cursor = data.has_more ? data.next_cursor : null;
      } catch (e) {
        Logger.log('Batch pagination follow-up error: ' + e.message);
        break;
      }
    }
  }

  return mapped;
}

/**
 * Generic paginated query — returns all raw Notion page objects.
 * Returns {error: string} on failure (for backward compatibility with callers).
 * @param {string}  databaseId
 * @param {Object}  [filter]      Notion filter object
 * @param {Array}   [sorts]       Notion sorts array
 * @param {number}  [maxResults]  Optional cap; hard ceiling of 2000 always applies
 */
var _QUERY_ALL_CEILING = 2000;

function _queryAll(databaseId, filter, sorts, maxResults) {
  var limit = maxResults ? Math.min(maxResults, _QUERY_ALL_CEILING) : _QUERY_ALL_CEILING;
  var allResults = [];
  var cursor = undefined;
  do {
    var body = { page_size: 100 };
    if (filter) body.filter = filter;
    if (sorts)  body.sorts  = sorts;
    if (cursor) body.start_cursor = cursor;

    try {
      var data = _notionFetch('databases/' + databaseId + '/query', body);
      if (!data.results) return { error: 'Unexpected response (no results array)' };
      allResults.push.apply(allResults, data.results);
      if (allResults.length >= limit) {
        allResults.length = limit;
        break;
      }
      cursor = data.has_more ? data.next_cursor : undefined;
      if (cursor) Utilities.sleep(200); // Rate-limit cushion between pages
    } catch (e) {
      return { error: e.message };
    }
  } while (cursor);
  return allResults;
}

/**
 * Retrieve the property names defined on a Notion database.
 * Used by the health check to validate expected schema.
 * @param {string} dbId  Notion database ID
 * @returns {Array<string>|Object} Array of property names, or { error } on failure.
 */
function _getDbProperties(dbId) {
  try {
    var data = _notionGet('databases/' + dbId);
    return Object.keys(data.properties || {});
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * Create a Notion page. Throws on error. Returns raw page object.
 */
function _notionCreatePage(databaseId, properties) {
  return _notionFetch('pages', {
    parent: { database_id: databaseId },
    properties: properties,
  });
}

/**
 * Update a Notion page's properties. Throws on error. Returns raw page object.
 */
function _notionUpdatePage(pageId, properties) {
  return _notionPatch('pages/' + pageId, { properties: properties });
}


// ── Property Mappers ─────────────────────────────────────────

function _mapClientProperties(page, fallbackName) {
  const p  = page.properties;
  const C  = NP.CLIENTS;
  const primaryContactRel = p[C.PRIMARY_CONTACT]?.relation || [];
  return {
    id:               page.id,
    notionUrl:        page.url || '',
    name:             p[C.NAME]?.title[0]?.plain_text                 || fallbackName || '(unnamed)',
    type:             p[C.TYPE]?.select?.name                         || '',
    status:           p[C.STATUS]?.select?.name                       || '',
    primaryContactId: primaryContactRel.length > 0 ? primaryContactRel[0].id : '',
    billingStreet:    p[C.BILLING_STREET]?.rich_text[0]?.plain_text   || '',
    billingCity:      p[C.BILLING_CITY]?.rich_text[0]?.plain_text     || '',
    billingState:     p[C.BILLING_STATE]?.rich_text[0]?.plain_text    || '',
    billingZip:       p[C.BILLING_ZIP]?.rich_text[0]?.plain_text      || '',
    billingCountry:   p[C.BILLING_COUNTRY]?.rich_text[0]?.plain_text  || '',
    billingEmail:     p[C.BILLING_EMAIL]?.email                       || '',
    phone:            p[C.PHONE]?.phone_number                        || '',
    website:          p[C.WEBSITE]?.url                               || '',
    driveFolderId:    p[C.DRIVE_FOLDER_ID]?.rich_text[0]?.plain_text  || '',
    notes:            p[C.NOTES]?.rich_text[0]?.plain_text            || '',
    withholdingAgent: p[C.WITHHOLDING_AGENT]?.checkbox                || false,
    withholdingRate:  p[C.WITHHOLDING_RATE]?.number                   ?? 10,
  };
}

function _mapContactProperties(page) {
  const p = page.properties;
  const C = NP.CONTACTS;
  const clientRel = p[C.CLIENT]?.relation || [];
  return {
    id:        page.id,
    notionUrl: page.url || '',
    name:      p[C.NAME]?.title[0]?.plain_text      || '(unnamed)',
    clientId:  clientRel.length > 0 ? clientRel[0].id : '',
    clientIds: clientRel.map(function(r) { return r.id; }),
    role:      p[C.ROLE]?.rich_text[0]?.plain_text  || '',
    email:     p[C.EMAIL]?.email                    || '',
    phone:     p[C.PHONE]?.phone_number             || '',
    notes:     p[C.NOTES]?.rich_text[0]?.plain_text || '',
  };
}

function _mapProjectProperties(page) {
  const p = page.properties;
  const C = NP.PROJECTS;
  const clientRel = p[C.CLIENT]?.relation || [];
  return {
    id:        page.id,
    notionUrl: page.url || '',
    name:      p[C.NAME]?.title[0]?.plain_text        || '(unnamed)',
    clientId:  clientRel.length > 0 ? clientRel[0].id : '',
    type:      p[C.TYPE]?.select?.name                || '',
    status:    p[C.STATUS]?.select?.name              || '',
    startDate: p[C.START_DATE]?.date?.start           || '',
    endDate:   p[C.END_DATE]?.date?.start             || '',
    notes:     p[C.NOTES]?.rich_text[0]?.plain_text   || '',
  };
}

function _mapAgreementProperties(page) {
  const p = page.properties;
  const C = NP.AGREEMENTS;
  const clientRel  = p[C.CLIENT]?.relation  || [];
  const projectRel = p[C.PROJECT]?.relation || [];
  return {
    id:            page.id,
    notionUrl:     page.url || '',
    title:         p[C.TITLE]?.title[0]?.plain_text           || '(untitled)',
    docType:       p[C.DOC_TYPE]?.select?.name                || '',
    status:        p[C.STATUS]?.select?.name                  || '',
    clientId:      clientRel.length > 0  ? clientRel[0].id   : '',
    projectId:     projectRel.length > 0 ? projectRel[0].id  : '',
    effectiveDate: p[C.EFFECTIVE_DATE]?.date?.start           || '',
    signedDate:    p[C.SIGNED_DATE]?.date?.start              || '',
    fileUrl:       p[C.FILE_URL]?.url                         || '',
    notes:         p[C.NOTES]?.rich_text[0]?.plain_text       || '',
  };
}

function _mapInvoiceProperties(page) {
  const p = page.properties;
  const C = NP.INVOICES;
  const clientRel    = p[C.CLIENT]?.relation    || [];
  const projectRel   = p[C.PROJECT]?.relation   || [];
  const agreementRel = p[C.AGREEMENT]?.relation || [];
  return {
    id:            page.id,
    notionUrl:     page.url || '',
    invoiceId:     p[C.INVOICE_ID]?.title[0]?.plain_text    || '',
    type:          p[C.TYPE]?.select?.name                  || '',
    status:        p[C.STATUS]?.select?.name                || '',
    clientId:      clientRel.length > 0    ? clientRel[0].id    : '',
    projectId:     projectRel.length > 0   ? projectRel[0].id   : '',
    agreementId:   agreementRel.length > 0 ? agreementRel[0].id : '',
    issuedDate:    p[C.ISSUED_DATE]?.date?.start             || '',
    dueDate:       p[C.DUE_DATE]?.date?.start                || '',
    paidDate:      p[C.PAID_DATE]?.date?.start               || '',
    periodMonth:   p[C.PERIOD_MONTH]?.rich_text[0]?.plain_text || '',
    subtotal:      p[C.SUBTOTAL]?.number                     ?? 0,
    tax:           p[C.TAX]?.number                          ?? 0,
    total:         p[C.TOTAL]?.number                        ?? 0,
    lineItems:     p[C.LINE_ITEMS]?.rich_text[0]?.plain_text || '',
    driveLink:     p[C.DRIVE_LINK]?.url                      || '',
    notes:         p[C.NOTES]?.rich_text[0]?.plain_text      || '',
  };
}

function _mapExpenseProperties(page) {
  const p = page.properties;
  const C = NP.EXPENSES;
  const projectRel    = p[C.PROJECT]?.relation    || [];
  const clientRel     = p[C.CLIENT]?.relation     || [];
  const contractorRel = p[C.CONTRACTOR]?.relation || [];
  const invoiceRel    = p[C.INVOICE]?.relation    || [];
  return {
    id:           page.id,
    notionUrl:    page.url || '',
    expenseId:    p[C.EXPENSE_ID]?.title[0]?.plain_text      || '',
    description:  p[C.DESCRIPTION]?.rich_text[0]?.plain_text || '',
    type:         p[C.TYPE]?.select?.name                    || '',
    projectId:    projectRel.length > 0    ? projectRel[0].id    : '',
    clientId:     clientRel.length > 0     ? clientRel[0].id     : '',
    contractorId: contractorRel.length > 0 ? contractorRel[0].id : '',
    invoiceId:    invoiceRel.length > 0    ? invoiceRel[0].id    : '',
    category:     p[C.CATEGORY]?.select?.name                || '',
    amount:       p[C.AMOUNT]?.number                        ?? 0,
    expenseDate:  p[C.EXPENSE_DATE]?.date?.start             || '',
    vendor:       p[C.VENDOR]?.rich_text[0]?.plain_text      || '',
    billable:     p[C.BILLABLE]?.checkbox                    || false,
    receiptUrl:   p[C.RECEIPT_URL]?.url                      || '',
    status:       p[C.STATUS]?.select?.name                  || '',
    notes:        p[C.NOTES]?.rich_text[0]?.plain_text       || '',
  };
}

function _mapPaymentProperties(page) {
  const p = page.properties;
  const C = NP.PAYMENTS;
  const invoiceRel = p[C.INVOICE]?.relation || [];
  const clientRel  = p[C.CLIENT]?.relation  || [];
  return {
    id:             page.id,
    notionUrl:      page.url || '',
    paymentId:      p[C.PAYMENT_ID]?.title[0]?.plain_text      || '',
    description:    p[C.DESCRIPTION]?.rich_text[0]?.plain_text || '',
    invoiceId:      invoiceRel.length > 0 ? invoiceRel[0].id   : '',
    clientId:       clientRel.length > 0  ? clientRel[0].id    : '',
    amount:         p[C.AMOUNT]?.number                        ?? 0,
    amountWithheld: p[C.AMOUNT_WITHHELD]?.number               ?? 0,
    method:         p[C.METHOD]?.select?.name                  || '',
    paymentDate:    p[C.PAYMENT_DATE]?.date?.start             || '',
    status:         p[C.STATUS]?.select?.name                  || '',
    receiptUrl:     p[C.RECEIPT_URL]?.url                      || '',
    notes:          p[C.NOTES]?.rich_text[0]?.plain_text       || '',
  };
}


// ── Client Queries ───────────────────────────────────────────

function lookupClientByName(name) {
  try {
    const data = _notionFetch('databases/' + CONFIG.NOTION_CLIENTS_DB + '/query', {
      filter: {
        and: [
          { property: NP.CLIENTS.NAME,   title:  { equals: name } },
          { property: NP.CLIENTS.STATUS, select: { equals: 'Active' } },
        ]
      },
      page_size: 1,
    });
    if (!data.results || !data.results.length) return null;
    return _mapClientProperties(data.results[0], name);
  } catch (e) {
    Logger.log('lookupClientByName error: ' + e.message);
    return null;
  }
}

function getClients() {
  const raw = _queryAll(CONFIG.NOTION_CLIENTS_DB,
    { property: NP.CLIENTS.STATUS, select: { equals: 'Active' } },
    [{ property: NP.CLIENTS.NAME, direction: 'ascending' }]
  );
  if (raw.error) return raw;
  return raw.map(r => _mapClientProperties(r));
}

function getClientById(clientId) {
  try {
    const data = _notionGet('pages/' + clientId);
    return _mapClientProperties(data);
  } catch (e) {
    Logger.log('getClientById error: ' + e.message);
    return null;
  }
}

function createNotionClient(props) {
  const C = NP.CLIENTS;
  const properties = {};
  properties[C.NAME]   = { title: [{ text: { content: props.name } }] };
  properties[C.TYPE]   = { select: { name: props.type || 'Business' } };
  properties[C.STATUS] = { select: { name: 'Active' } };
  if (props.billingEmail)   properties[C.BILLING_EMAIL]   = { email: props.billingEmail };
  if (props.billingStreet)  properties[C.BILLING_STREET]  = { rich_text: [{ text: { content: props.billingStreet } }] };
  if (props.billingCity)    properties[C.BILLING_CITY]    = { rich_text: [{ text: { content: props.billingCity } }] };
  if (props.billingState)   properties[C.BILLING_STATE]   = { rich_text: [{ text: { content: props.billingState } }] };
  if (props.billingZip)     properties[C.BILLING_ZIP]     = { rich_text: [{ text: { content: props.billingZip } }] };
  if (props.billingCountry) properties[C.BILLING_COUNTRY] = { rich_text: [{ text: { content: props.billingCountry } }] };
  if (props.phone)   properties[C.PHONE]   = { phone_number: props.phone };
  if (props.website) properties[C.WEBSITE] = { url: props.website };
  if (props.notes)   properties[C.NOTES]   = { rich_text: [{ text: { content: props.notes } }] };
  if (props.withholdingAgent !== undefined) properties[C.WITHHOLDING_AGENT] = { checkbox: !!props.withholdingAgent };
  if (props.withholdingRate  !== undefined) properties[C.WITHHOLDING_RATE]  = { number: parseFloat(props.withholdingRate) || 10 };
  return _notionCreatePage(CONFIG.NOTION_CLIENTS_DB, properties);
}

function updateClientDriveFolderId(clientPageId, folderId) {
  const properties = {};
  properties[NP.CLIENTS.DRIVE_FOLDER_ID] = { rich_text: [{ text: { content: folderId } }] };
  return _notionUpdatePage(clientPageId, properties);
}

function updateClientInfo(clientId, props) {
  const C = NP.CLIENTS;
  const properties = {};
  if (props.name !== undefined)           properties[C.NAME]            = { title: [{ text: { content: props.name } }] };
  if (props.type !== undefined)           properties[C.TYPE]            = { select: { name: props.type } };
  if (props.status !== undefined)         properties[C.STATUS]          = { select: { name: props.status } };
  if (props.billingEmail !== undefined)   properties[C.BILLING_EMAIL]   = props.billingEmail ? { email: props.billingEmail } : { email: null };
  if (props.billingStreet !== undefined)  properties[C.BILLING_STREET]  = { rich_text: [{ text: { content: props.billingStreet || '' } }] };
  if (props.billingCity !== undefined)    properties[C.BILLING_CITY]    = { rich_text: [{ text: { content: props.billingCity || '' } }] };
  if (props.billingState !== undefined)   properties[C.BILLING_STATE]   = { rich_text: [{ text: { content: props.billingState || '' } }] };
  if (props.billingZip !== undefined)     properties[C.BILLING_ZIP]     = { rich_text: [{ text: { content: props.billingZip || '' } }] };
  if (props.billingCountry !== undefined) properties[C.BILLING_COUNTRY] = { rich_text: [{ text: { content: props.billingCountry || '' } }] };
  if (props.phone !== undefined)   properties[C.PHONE]   = props.phone ? { phone_number: props.phone } : { phone_number: null };
  if (props.website !== undefined) properties[C.WEBSITE] = props.website ? { url: props.website } : { url: null };
  if (props.notes !== undefined)   properties[C.NOTES]   = { rich_text: [{ text: { content: props.notes || '' } }] };
  if (props.withholdingAgent !== undefined) properties[C.WITHHOLDING_AGENT] = { checkbox: !!props.withholdingAgent };
  if (props.withholdingRate  !== undefined) properties[C.WITHHOLDING_RATE]  = { number: parseFloat(props.withholdingRate) || 10 };
  return _notionUpdatePage(clientId, properties);
}


// ── Contact Queries ──────────────────────────────────────────

/**
 * Retrieve all contacts across all clients (no filter).
 * Used by the data backup feature.
 * @returns {Array}
 */
function getAllContacts() {
  const raw = _queryAll(CONFIG.NOTION_CONTACTS_DB, null,
    [{ property: NP.CONTACTS.NAME, direction: 'ascending' }]
  );
  if (raw.error) return raw;
  return raw.map(r => _mapContactProperties(r));
}

function getContactsByClient(clientId) {
  const raw = _queryAll(CONFIG.NOTION_CONTACTS_DB,
    { property: NP.CONTACTS.CLIENT, relation: { contains: clientId } },
    [{ property: NP.CONTACTS.NAME, direction: 'ascending' }]
  );
  if (raw.error) return raw;
  return raw.map(r => _mapContactProperties(r));
}

/**
 * Get the primary contact for a client.
 * Reads the "Primary Contact" relation from the Client record.
 * Falls back to the first contact if no primary is set.
 */
function getPrimaryContact(clientId) {
  try {
    var client = _notionGet('pages/' + clientId);
    var mapped = _mapClientProperties(client);
    if (mapped.primaryContactId) {
      return getContactById(mapped.primaryContactId);
    }
    // Fallback: first contact linked to this client
    var contacts = getContactsByClient(clientId);
    if (contacts.error || !contacts.length) return null;
    return contacts[0];
  } catch (e) {
    Logger.log('getPrimaryContact error: ' + e.message);
    return null;
  }
}

function getContactById(contactId) {
  try {
    var data = _notionGet('pages/' + contactId);
    return _mapContactProperties(data);
  } catch (e) {
    Logger.log('getContactById error: ' + e.message);
    return null;
  }
}

function updateContactInfo(contactId, props) {
  const C = NP.CONTACTS;
  const properties = {};
  if (props.name !== undefined)  properties[C.NAME]  = { title: [{ text: { content: props.name } }] };
  if (props.role !== undefined)  properties[C.ROLE]  = { rich_text: [{ text: { content: props.role || '' } }] };
  if (props.email !== undefined) properties[C.EMAIL] = props.email ? { email: props.email } : { email: null };
  if (props.phone !== undefined) properties[C.PHONE] = props.phone ? { phone_number: props.phone } : { phone_number: null };
  if (props.notes !== undefined) properties[C.NOTES] = { rich_text: [{ text: { content: props.notes || '' } }] };
  return _notionUpdatePage(contactId, properties);
}

function archiveNotionPage(pageId) {
  return _notionPatch('pages/' + pageId, { archived: true });
}

function createNotionContact(props) {
  const C = NP.CONTACTS;
  const properties = {};
  properties[C.NAME] = { title: [{ text: { content: props.name } }] };
  if (props.clientId) properties[C.CLIENT] = { relation: [{ id: props.clientId }] };
  if (props.role)     properties[C.ROLE]   = { rich_text: [{ text: { content: props.role } }] };
  if (props.email)    properties[C.EMAIL]  = { email: props.email };
  if (props.phone)    properties[C.PHONE]  = { phone_number: props.phone };
  if (props.notes)    properties[C.NOTES]  = { rich_text: [{ text: { content: props.notes } }] };
  return _notionCreatePage(CONFIG.NOTION_CONTACTS_DB, properties);
}


// ── Project Queries ──────────────────────────────────────────

function getProjects() {
  const C = NP.PROJECTS;
  const raw = _queryAll(CONFIG.NOTION_PROJECTS_DB,
    { or: [
      { property: C.STATUS, select: { equals: 'Active' } },
      { property: C.STATUS, select: { equals: 'Draft' } },
      { property: C.STATUS, select: { equals: 'Paused' } },
      { property: C.STATUS, select: { equals: 'Closed' } },
    ]},
    [{ property: C.NAME, direction: 'ascending' }]
  );
  if (raw.error) return raw;
  return raw.map(r => _mapProjectProperties(r));
}

function getProjectsByClient(clientId) {
  const C = NP.PROJECTS;
  const raw = _queryAll(CONFIG.NOTION_PROJECTS_DB,
    { and: [
      { property: C.CLIENT, relation: { contains: clientId } },
      { or: [
        { property: C.STATUS, select: { equals: 'Active' } },
        { property: C.STATUS, select: { equals: 'Draft' } },
        { property: C.STATUS, select: { equals: 'Paused' } },
        { property: C.STATUS, select: { equals: 'Closed' } },
      ]},
    ]},
    [{ property: C.NAME, direction: 'ascending' }]
  );
  if (raw.error) return raw;
  return raw.map(r => _mapProjectProperties(r));
}

function getProjectById(projectId) {
  try {
    const data = _notionGet('pages/' + projectId);
    return _mapProjectProperties(data);
  } catch (e) {
    Logger.log('getProjectById error: ' + e.message);
    return null;
  }
}

function lookupProjectByName(name) {
  try {
    const C = NP.PROJECTS;
    const data = _notionFetch('databases/' + CONFIG.NOTION_PROJECTS_DB + '/query', {
      filter: {
        and: [
          { property: C.NAME, title: { equals: name } },
          { or: [
            { property: C.STATUS, select: { equals: 'Active' } },
            { property: C.STATUS, select: { equals: 'Draft' } },
          ]},
        ]
      },
      page_size: 1,
    });
    if (!data.results || !data.results.length) return null;
    return _mapProjectProperties(data.results[0]);
  } catch (e) {
    Logger.log('lookupProjectByName error: ' + e.message);
    return null;
  }
}

function createNotionProject(props) {
  const C = NP.PROJECTS;
  const properties = {};
  properties[C.NAME]   = { title: [{ text: { content: props.name } }] };
  properties[C.TYPE]   = { select: { name: props.type || 'One-Off' } };
  properties[C.STATUS] = { select: { name: props.status || 'Draft' } };
  if (props.clientId)  properties[C.CLIENT]     = { relation: [{ id: props.clientId }] };
  if (props.startDate) properties[C.START_DATE] = { date: { start: props.startDate } };
  if (props.endDate)   properties[C.END_DATE]   = { date: { start: props.endDate } };
  if (props.notes)     properties[C.NOTES]      = { rich_text: [{ text: { content: props.notes } }] };
  return _notionCreatePage(CONFIG.NOTION_PROJECTS_DB, properties);
}

function updateProjectStatus(projectId, status) {
  const properties = {};
  properties[NP.PROJECTS.STATUS] = { select: { name: status } };
  return _notionUpdatePage(projectId, properties);
}

function updateProjectInfo(projectId, props) {
  const C = NP.PROJECTS;
  const properties = {};
  if (props.name !== undefined)      properties[C.NAME]       = { title: [{ text: { content: props.name } }] };
  if (props.type !== undefined)      properties[C.TYPE]       = { select: { name: props.type } };
  if (props.status !== undefined)    properties[C.STATUS]     = { select: { name: props.status } };
  if (props.startDate !== undefined) properties[C.START_DATE] = props.startDate ? { date: { start: props.startDate } } : { date: null };
  if (props.endDate !== undefined)   properties[C.END_DATE]   = props.endDate   ? { date: { start: props.endDate } }   : { date: null };
  if (props.notes !== undefined)     properties[C.NOTES]      = { rich_text: [{ text: { content: props.notes || '' } }] };
  return _notionUpdatePage(projectId, properties);
}


// ── Agreement Queries ────────────────────────────────────────

function getAgreementsByProject(projectId) {
  const raw = _queryAll(CONFIG.NOTION_AGREEMENTS_DB,
    { property: NP.AGREEMENTS.PROJECT, relation: { contains: projectId } },
    [{ property: NP.AGREEMENTS.EFFECTIVE_DATE, direction: 'descending' }]
  );
  if (raw.error) return raw;
  return raw.map(r => _mapAgreementProperties(r));
}

/**
 * Retrieve all agreements across all clients/projects (no filter).
 * Used by the data backup feature.
 * @returns {Array}
 */
function getAllAgreements() {
  const raw = _queryAll(CONFIG.NOTION_AGREEMENTS_DB, null,
    [{ property: NP.AGREEMENTS.EFFECTIVE_DATE, direction: 'descending' }]
  );
  if (raw.error) return raw;
  return raw.map(r => _mapAgreementProperties(r));
}

function createNotionAgreement(props) {
  const C = NP.AGREEMENTS;
  const properties = {};
  properties[C.TITLE]   = { title: [{ text: { content: props.title } }] };
  properties[C.DOC_TYPE] = { select: { name: props.docType } };
  properties[C.STATUS]  = { select: { name: props.status || 'Draft' } };
  if (props.clientId)      properties[C.CLIENT]         = { relation: [{ id: props.clientId }] };
  if (props.projectId)     properties[C.PROJECT]        = { relation: [{ id: props.projectId }] };
  if (props.effectiveDate) properties[C.EFFECTIVE_DATE] = { date: { start: props.effectiveDate } };
  if (props.signedDate)    properties[C.SIGNED_DATE]    = { date: { start: props.signedDate } };
  if (props.fileUrl)       properties[C.FILE_URL]       = { url: props.fileUrl };
  if (props.notes)         properties[C.NOTES]          = { rich_text: [{ text: { content: props.notes } }] };
  return _notionCreatePage(CONFIG.NOTION_AGREEMENTS_DB, properties);
}

function updateAgreementStatus(agreementId, status) {
  const properties = {};
  properties[NP.AGREEMENTS.STATUS] = { select: { name: status } };
  return _notionUpdatePage(agreementId, properties);
}

function updateAgreementInfo(agreementId, props) {
  const C = NP.AGREEMENTS;
  const properties = {};
  if (props.title !== undefined)         properties[C.TITLE]          = { title: [{ text: { content: props.title } }] };
  if (props.docType !== undefined)       properties[C.DOC_TYPE]       = { select: { name: props.docType } };
  if (props.effectiveDate !== undefined) properties[C.EFFECTIVE_DATE] = props.effectiveDate ? { date: { start: props.effectiveDate } } : { date: null };
  if (props.fileUrl !== undefined)       properties[C.FILE_URL]       = props.fileUrl ? { url: props.fileUrl } : { url: null };
  if (props.notes !== undefined)         properties[C.NOTES]          = { rich_text: [{ text: { content: props.notes || '' } }] };
  return _notionUpdatePage(agreementId, properties);
}


// ── Invoice Queries ──────────────────────────────────────────

function getInvoicesByProject(projectId) {
  const raw = _queryAll(CONFIG.NOTION_INVOICES_DB,
    { property: NP.INVOICES.PROJECT, relation: { contains: projectId } },
    [{ property: NP.INVOICES.ISSUED_DATE, direction: 'descending' }]
  );
  if (raw.error) return raw;
  return raw.map(r => _mapInvoiceProperties(r));
}

function getAllInvoices() {
  const raw = _queryAll(CONFIG.NOTION_INVOICES_DB, null,
    [{ property: NP.INVOICES.ISSUED_DATE, direction: 'descending' }]
  );
  if (raw.error) return raw;
  return raw.map(r => _mapInvoiceProperties(r));
}

/**
 * Query invoices filtered by one or more statuses.
 * @param {Array<string>} statuses  e.g., ['Sent'] or ['Sent', 'Overdue']
 * @returns {Array}
 */
function getInvoicesByStatus(statuses) {
  var conditions = statuses.map(function(s) {
    return { property: NP.INVOICES.STATUS, select: { equals: s } };
  });
  var filter = conditions.length === 1 ? conditions[0] : { or: conditions };
  var raw = _queryAll(CONFIG.NOTION_INVOICES_DB, filter,
    [{ property: NP.INVOICES.ISSUED_DATE, direction: 'descending' }]);
  if (raw.error) return raw;
  return raw.map(function(r) { return _mapInvoiceProperties(r); });
}

/**
 * Query invoices with Status = 'Sent' and Due Date before a given date.
 * Returns only overdue candidates, minimizing data transfer.
 * @param {string} beforeDateISO  ISO date string (exclusive upper bound)
 * @returns {Array}
 */
function getSentInvoicesDueBefore(beforeDateISO) {
  var raw = _queryAll(CONFIG.NOTION_INVOICES_DB, {
    and: [
      { property: NP.INVOICES.STATUS,   select: { equals: 'Sent' } },
      { property: NP.INVOICES.DUE_DATE, date:   { before: beforeDateISO } },
    ]
  }, [{ property: NP.INVOICES.DUE_DATE, direction: 'ascending' }]);
  if (raw.error) return raw;
  return raw.map(function(r) { return _mapInvoiceProperties(r); });
}

/**
 * Query invoices whose Issued Date falls within [startDate, endDate].
 * Used by dashboard and reports to scope data to a fiscal year.
 * @param {string} startDate  ISO date (inclusive lower bound)
 * @param {string} endDate    ISO date (inclusive upper bound)
 * @returns {Array}
 */
function getInvoicesByDateRange(startDate, endDate) {
  var raw = _queryAll(CONFIG.NOTION_INVOICES_DB, {
    and: [
      { property: NP.INVOICES.ISSUED_DATE, date: { on_or_after:  startDate } },
      { property: NP.INVOICES.ISSUED_DATE, date: { on_or_before: endDate } },
    ]
  }, [{ property: NP.INVOICES.ISSUED_DATE, direction: 'descending' }]);
  if (raw.error) return raw;
  return raw.map(function(r) { return _mapInvoiceProperties(r); });
}

function getAllExpenses() {
  const raw = _queryAll(CONFIG.NOTION_EXPENSES_DB, null,
    [{ property: NP.EXPENSES.EXPENSE_DATE, direction: 'descending' }]
  );
  if (raw.error) return raw;
  return raw.map(r => _mapExpenseProperties(r));
}

/**
 * Query expenses whose Expense Date falls within [startDate, endDate].
 * Used by dashboard and reports to scope data to a fiscal year.
 * @param {string} startDate  ISO date (inclusive lower bound)
 * @param {string} endDate    ISO date (inclusive upper bound)
 * @returns {Array}
 */
function getExpensesByDateRange(startDate, endDate) {
  var raw = _queryAll(CONFIG.NOTION_EXPENSES_DB, {
    and: [
      { property: NP.EXPENSES.EXPENSE_DATE, date: { on_or_after:  startDate } },
      { property: NP.EXPENSES.EXPENSE_DATE, date: { on_or_before: endDate } },
    ]
  }, [{ property: NP.EXPENSES.EXPENSE_DATE, direction: 'descending' }]);
  if (raw.error) return raw;
  return raw.map(function(r) { return _mapExpenseProperties(r); });
}

function getInvoiceById(invoicePageId) {
  try {
    const data = _notionGet('pages/' + invoicePageId);
    return _mapInvoiceProperties(data);
  } catch (e) {
    Logger.log('getInvoiceById error: ' + e.message);
    return null;
  }
}

function updateInvoiceStatus(invoicePageId, status, paidDate) {
  const C = NP.INVOICES;
  const props = {};
  props[C.STATUS] = { select: { name: status } };
  if (paidDate) props[C.PAID_DATE] = { date: { start: paidDate } };
  return _notionUpdatePage(invoicePageId, props);
}

/** Original logToNotion — kept for backward compatibility with InvoiceService. */
function logToNotion(invoiceId, data, driveUrl) {
  const C = NP.INVOICES;
  const lineItemsSummary = data.lineItems
    .map(i => `${i.name} (x${i.qty}) — $${formatCurrency(i.qty * i.price)}`)
    .join('\n');

  const properties = {};
  properties[C.INVOICE_ID]  = { title:  [{ text: { content: invoiceId } }] };
  properties[C.TYPE]        = { select: { name: data.invoiceType } };
  properties[C.STATUS]      = { select: { name: 'Draft' } };
  properties[C.ISSUED_DATE] = { date:   { start: data.issueDateISO } };
  properties[C.DUE_DATE]    = { date:   { start: data.dueDateISO } };
  properties[C.SUBTOTAL]    = { number: data.subtotal };
  properties[C.TAX]         = { number: data.taxes };
  properties[C.TOTAL]       = { number: data.total };
  properties[C.LINE_ITEMS]  = { rich_text: [{ text: { content: lineItemsSummary } }] };
  properties[C.DRIVE_LINK]  = { url: driveUrl };
  if (data.clientId)  properties[C.CLIENT]  = { relation: [{ id: data.clientId }] };
  if (data.projectId) properties[C.PROJECT] = { relation: [{ id: data.projectId }] };

  try {
    var page = _notionCreatePage(CONFIG.NOTION_INVOICES_DB, properties);
    return { success: true, pageId: page.id };
  } catch (e) {
    Logger.log('logToNotion error: ' + e.message);
    return { success: false, error: e.message };
  }
}


// ── Quote Queries ────────────────────────────────────────────

function logQuoteToNotion(quoteId, data, driveUrl) {
  const C = NP.QUOTES;
  var lineItemsSummary = data.lineItems
    .map(function(i) { return i.name + ' (x' + i.qty + ') — $' + formatCurrency(i.qty * i.price); })
    .join('\n');

  var properties = {};
  properties[C.QUOTE_ID]    = { title: [{ text: { content: quoteId } }] };
  properties[C.STATUS]      = { select: { name: 'Draft' } };
  properties[C.ISSUED_DATE] = { date: { start: data.issueDateISO } };
  properties[C.VALID_UNTIL] = { date: { start: data.validDateISO } };
  properties[C.SUBTOTAL]    = { number: data.subtotal };
  properties[C.TAX]         = { number: data.taxes };
  properties[C.TOTAL]       = { number: data.total };
  properties[C.LINE_ITEMS]  = { rich_text: [{ text: { content: lineItemsSummary } }] };
  properties[C.DRIVE_LINK]  = { url: driveUrl };
  if (data.clientId)  properties[C.CLIENT]  = { relation: [{ id: data.clientId }] };
  if (data.projectId) properties[C.PROJECT] = { relation: [{ id: data.projectId }] };

  try {
    var page = _notionCreatePage(CONFIG.NOTION_QUOTES_DB, properties);
    return { success: true, pageId: page.id };
  } catch (e) {
    Logger.log('logQuoteToNotion error: ' + e.message);
    return { success: false, error: e.message };
  }
}

function _mapQuoteProperties(page) {
  const p = page.properties;
  const C = NP.QUOTES;
  const clientRel  = p[C.CLIENT]?.relation  || [];
  const projectRel = p[C.PROJECT]?.relation || [];
  const invoiceRel = p[C.CONVERTED_INVOICE]?.relation || [];
  return {
    id:                 page.id,
    notionUrl:          page.url || '',
    quoteId:            p[C.QUOTE_ID]?.title[0]?.plain_text      || '',
    status:             p[C.STATUS]?.select?.name                || '',
    clientId:           clientRel.length > 0  ? clientRel[0].id  : '',
    projectId:          projectRel.length > 0 ? projectRel[0].id : '',
    convertedInvoiceId: invoiceRel.length > 0 ? invoiceRel[0].id : '',
    issuedDate:         p[C.ISSUED_DATE]?.date?.start            || '',
    validUntil:         p[C.VALID_UNTIL]?.date?.start            || '',
    subtotal:           p[C.SUBTOTAL]?.number                    ?? 0,
    tax:                p[C.TAX]?.number                         ?? 0,
    total:              p[C.TOTAL]?.number                       ?? 0,
    lineItems:          p[C.LINE_ITEMS]?.rich_text[0]?.plain_text || '',
    driveLink:          p[C.DRIVE_LINK]?.url                     || '',
    notes:              p[C.NOTES]?.rich_text[0]?.plain_text     || '',
  };
}

function getAllQuotes() {
  var raw = _queryAll(CONFIG.NOTION_QUOTES_DB, null,
    [{ property: NP.QUOTES.ISSUED_DATE, direction: 'descending' }]);
  if (raw.error) return raw;
  return raw.map(function(r) { return _mapQuoteProperties(r); });
}

function getQuoteById(quotePageId) {
  try {
    var data = _notionGet('pages/' + quotePageId);
    return _mapQuoteProperties(data);
  } catch (e) {
    Logger.log('getQuoteById error: ' + e.message);
    return null;
  }
}

function getQuotesByClient(clientId) {
  var raw = _queryAll(CONFIG.NOTION_QUOTES_DB,
    { property: NP.QUOTES.CLIENT, relation: { contains: clientId } },
    [{ property: NP.QUOTES.ISSUED_DATE, direction: 'descending' }]);
  if (raw.error) return raw;
  return raw.map(function(r) { return _mapQuoteProperties(r); });
}

function updateQuoteStatus(quotePageId, status) {
  const properties = {};
  properties[NP.QUOTES.STATUS] = { select: { name: status } };
  return _notionPatch('pages/' + quotePageId, { properties: properties });
}

function linkQuoteToInvoice(quotePageId, invoicePageId) {
  const C = NP.QUOTES;
  const props = {};
  props[C.STATUS] = { select: { name: 'Accepted' } };
  if (invoicePageId) props[C.CONVERTED_INVOICE] = { relation: [{ id: invoicePageId }] };
  return _notionPatch('pages/' + quotePageId, { properties: props });
}

function updateQuoteRecord(quotePageId, data) {
  const C = NP.QUOTES;
  var lineItemsSummary = data.lineItems
    .map(function(i) { return i.name + ' (x' + i.qty + ') \u2014 $' + formatCurrency(i.qty * i.price); })
    .join('\n');
  var props = {};
  props[C.ISSUED_DATE] = { date: { start: data.issueDateISO } };
  props[C.VALID_UNTIL] = { date: { start: data.validDateISO } };
  props[C.SUBTOTAL]    = { number: data.subtotal };
  props[C.TAX]         = { number: data.taxes || 0 };
  props[C.TOTAL]       = { number: data.total };
  props[C.LINE_ITEMS]  = { rich_text: [{ text: { content: lineItemsSummary } }] };
  if (data.driveUrl)            props[C.DRIVE_LINK] = { url: data.driveUrl };
  if (data.notes !== undefined) props[C.NOTES]      = { rich_text: [{ text: { content: data.notes || '' } }] };
  if (data.projectId)           props[C.PROJECT]    = { relation: [{ id: data.projectId }] };
  return _notionUpdatePage(quotePageId, props);
}

// ── Expense Queries ──────────────────────────────────────────

function getExpensesByProject(projectId) {
  const raw = _queryAll(CONFIG.NOTION_EXPENSES_DB,
    { property: NP.EXPENSES.PROJECT, relation: { contains: projectId } },
    [{ property: NP.EXPENSES.EXPENSE_DATE, direction: 'descending' }]
  );
  if (raw.error) return raw;
  return raw.map(r => _mapExpenseProperties(r));
}

function createNotionExpense(props) {
  const C = NP.EXPENSES;
  const properties = {};
  properties[C.EXPENSE_ID] = { title: [{ text: { content: props.expenseId || '' } }] };
  properties[C.CATEGORY]   = { select: { name: props.category || 'Operations' } };
  properties[C.AMOUNT]     = { number: parseFloat(props.amount) || 0 };
  properties[C.STATUS]     = { select: { name: props.status || 'Logged' } };
  if (props.description)   properties[C.DESCRIPTION]  = { rich_text: [{ text: { content: props.description } }] };
  if (props.type)          properties[C.TYPE]          = { select: { name: props.type } };
  if (props.projectId)     properties[C.PROJECT]       = { relation: [{ id: props.projectId }] };
  if (props.clientId)      properties[C.CLIENT]        = { relation: [{ id: props.clientId }] };
  if (props.contractorId)  properties[C.CONTRACTOR]    = { relation: [{ id: props.contractorId }] };
  if (props.expenseDate)   properties[C.EXPENSE_DATE]  = { date: { start: props.expenseDate } };
  if (props.vendor)        properties[C.VENDOR]        = { rich_text: [{ text: { content: props.vendor } }] };
  if (props.billable !== undefined) properties[C.BILLABLE] = { checkbox: !!props.billable };
  if (props.receiptUrl)    properties[C.RECEIPT_URL]   = { url: props.receiptUrl };
  if (props.notes)         properties[C.NOTES]         = { rich_text: [{ text: { content: props.notes } }] };
  return _notionCreatePage(CONFIG.NOTION_EXPENSES_DB, properties);
}

function getExpenseById(expensePageId) {
  try {
    var data = _notionGet('pages/' + expensePageId);
    return _mapExpenseProperties(data);
  } catch (e) {
    Logger.log('getExpenseById error: ' + e.message);
    return null;
  }
}

function updateExpenseInfo(expensePageId, props) {
  const C = NP.EXPENSES;
  const properties = {};
  if (props.description !== undefined)  properties[C.DESCRIPTION]  = { rich_text: [{ text: { content: props.description || '' } }] };
  if (props.type !== undefined)         properties[C.TYPE]         = props.type ? { select: { name: props.type } } : { select: null };
  if (props.category !== undefined)     properties[C.CATEGORY]     = { select: { name: props.category || 'Operations' } };
  if (props.amount !== undefined)       properties[C.AMOUNT]       = { number: parseFloat(props.amount) || 0 };
  if (props.expenseDate !== undefined)  properties[C.EXPENSE_DATE] = props.expenseDate ? { date: { start: props.expenseDate } } : { date: null };
  if (props.vendor !== undefined)       properties[C.VENDOR]       = { rich_text: [{ text: { content: props.vendor || '' } }] };
  if (props.billable !== undefined)     properties[C.BILLABLE]     = { checkbox: !!props.billable };
  if (props.status !== undefined)       properties[C.STATUS]       = { select: { name: props.status || 'Logged' } };
  if (props.receiptUrl !== undefined)   properties[C.RECEIPT_URL]  = props.receiptUrl ? { url: props.receiptUrl } : { url: null };
  if (props.notes !== undefined)        properties[C.NOTES]        = { rich_text: [{ text: { content: props.notes || '' } }] };
  if (props.projectId !== undefined)    properties[C.PROJECT]      = props.projectId ? { relation: [{ id: props.projectId }] } : { relation: [] };
  if (props.clientId !== undefined)     properties[C.CLIENT]       = props.clientId ? { relation: [{ id: props.clientId }] } : { relation: [] };
  if (props.contractorId !== undefined) properties[C.CONTRACTOR]   = props.contractorId ? { relation: [{ id: props.contractorId }] } : { relation: [] };
  return _notionUpdatePage(expensePageId, properties);
}

/**
 * Get billable expenses for a client that haven't been linked to an invoice yet.
 * Used by the invoice generator to import billable expenses as line items.
 */
function getUnInvoicedBillableExpenses(clientId) {
  if (!clientId) return [];
  const C = NP.EXPENSES;
  var filter = {
    and: [
      { property: C.CLIENT,   relation: { contains: clientId } },
      { property: C.BILLABLE, checkbox: { equals: true } },
      { property: C.INVOICE,  relation: { is_empty: true } },
    ]
  };
  var raw = _queryAll(CONFIG.NOTION_EXPENSES_DB, filter,
    [{ property: C.EXPENSE_DATE, direction: 'descending' }]
  );
  if (raw.error) return [];
  return raw.map(function(r) { return _mapExpenseProperties(r); });
}

/**
 * Mark expenses as invoiced by setting their Invoice relation to the given invoice page ID.
 * Called after invoice generation to link the imported expenses.
 */
function markExpensesAsInvoiced(expensePageIds, invoicePageId) {
  if (!expensePageIds || !expensePageIds.length || !invoicePageId) return;
  expensePageIds.forEach(function(expenseId) {
    try {
      const properties = {};
      properties[NP.EXPENSES.INVOICE] = { relation: [{ id: invoicePageId }] };
      _notionUpdatePage(expenseId, properties);
    } catch (e) {
      Logger.log('markExpensesAsInvoiced error for ' + expenseId + ': ' + e.message);
    }
  });
}

// ── Payment Queries ──────────────────────────────────────────

function getPaymentsByInvoice(invoicePageId) {
  const raw = _queryAll(CONFIG.NOTION_PAYMENTS_DB,
    { property: NP.PAYMENTS.INVOICE, relation: { contains: invoicePageId } },
    [{ property: NP.PAYMENTS.PAYMENT_DATE, direction: 'descending' }]
  );
  if (raw.error) return raw;
  return raw.map(r => _mapPaymentProperties(r));
}

/**
 * Retrieve all payments across all invoices/clients (no filter).
 * Used by the data backup feature.
 * @returns {Array}
 */
function getAllPayments() {
  const raw = _queryAll(CONFIG.NOTION_PAYMENTS_DB, null,
    [{ property: NP.PAYMENTS.PAYMENT_DATE, direction: 'descending' }]
  );
  if (raw.error) return raw;
  return raw.map(r => _mapPaymentProperties(r));
}

function createNotionPayment(props) {
  const C = NP.PAYMENTS;
  const properties = {};
  properties[C.PAYMENT_ID] = { title: [{ text: { content: props.paymentId || '' } }] };
  properties[C.AMOUNT]     = { number: parseFloat(props.amount) || 0 };
  properties[C.METHOD]     = { select: { name: props.method || 'Check' } };
  properties[C.STATUS]     = { select: { name: props.status || 'Logged' } };
  if (props.description)    properties[C.DESCRIPTION]     = { rich_text: [{ text: { content: props.description } }] };
  if (props.invoiceId)      properties[C.INVOICE]         = { relation: [{ id: props.invoiceId }] };
  if (props.clientId)       properties[C.CLIENT]          = { relation: [{ id: props.clientId }] };
  if (props.paymentDate)    properties[C.PAYMENT_DATE]    = { date: { start: props.paymentDate } };
  if (props.receiptUrl)     properties[C.RECEIPT_URL]     = { url: props.receiptUrl };
  if (props.notes)          properties[C.NOTES]           = { rich_text: [{ text: { content: props.notes } }] };
  if (props.amountWithheld) properties[C.AMOUNT_WITHHELD] = { number: parseFloat(props.amountWithheld) || 0 };
  return _notionCreatePage(CONFIG.NOTION_PAYMENTS_DB, properties);
}

function getPaymentById(paymentPageId) {
  try {
    var data = _notionGet('pages/' + paymentPageId);
    return _mapPaymentProperties(data);
  } catch (e) {
    Logger.log('getPaymentById error: ' + e.message);
    return null;
  }
}

function updatePaymentInfo(paymentPageId, props) {
  const C = NP.PAYMENTS;
  const properties = {};
  if (props.description !== undefined)  properties[C.DESCRIPTION]     = { rich_text: [{ text: { content: props.description || '' } }] };
  if (props.amount !== undefined)       properties[C.AMOUNT]          = { number: parseFloat(props.amount) || 0 };
  if (props.method !== undefined)       properties[C.METHOD]          = props.method ? { select: { name: props.method } } : { select: null };
  if (props.paymentDate !== undefined)  properties[C.PAYMENT_DATE]    = props.paymentDate ? { date: { start: props.paymentDate } } : { date: null };
  if (props.status !== undefined)       properties[C.STATUS]          = { select: { name: props.status || 'Logged' } };
  if (props.receiptUrl !== undefined)   properties[C.RECEIPT_URL]     = props.receiptUrl ? { url: props.receiptUrl } : { url: null };
  if (props.notes !== undefined)        properties[C.NOTES]           = { rich_text: [{ text: { content: props.notes || '' } }] };
  if (props.invoiceId !== undefined)    properties[C.INVOICE]         = props.invoiceId ? { relation: [{ id: props.invoiceId }] } : { relation: [] };
  if (props.clientId !== undefined)     properties[C.CLIENT]          = props.clientId ? { relation: [{ id: props.clientId }] } : { relation: [] };
  if (props.amountWithheld !== undefined) properties[C.AMOUNT_WITHHELD] = { number: parseFloat(props.amountWithheld) || 0 };
  return _notionUpdatePage(paymentPageId, properties);
}

// ── Contractor Queries ───────────────────────────────────────

function _mapContractorProperties(page) {
  const p = page.properties;
  const C = NP.CONTRACTORS;
  const roles = (p[C.ROLES]?.multi_select || []).map(r => r.name);
  return {
    id:            page.id,
    notionUrl:     page.url || '',
    name:          p[C.NAME]?.title[0]?.plain_text          || '(unnamed)',
    email:         p[C.EMAIL]?.email                        || '',
    phone:         p[C.PHONE]?.phone_number                 || '',
    type:          p[C.TYPE]?.select?.name                  || '',
    roles:         roles,
    paymentMethod: p[C.PAYMENT_METHOD]?.select?.name        || '',
    isPartner:     p[C.IS_PARTNER]?.checkbox                || false,
    w9Url:         p[C.W9]?.url                             || '',
    notes:         p[C.NOTES]?.rich_text[0]?.plain_text     || '',
  };
}

function getAllContractors() {
  const raw = _queryAll(CONFIG.NOTION_CONTRACTORS_DB, null,
    [{ property: NP.CONTRACTORS.NAME, direction: 'ascending' }]
  );
  if (raw.error) return raw;
  return raw.map(r => _mapContractorProperties(r));
}

function getContractorById(contractorId) {
  try {
    var data = _notionGet('pages/' + contractorId);
    return _mapContractorProperties(data);
  } catch (e) {
    Logger.log('getContractorById error: ' + e.message);
    return null;
  }
}

function getExpensesByContractor(contractorId) {
  const raw = _queryAll(CONFIG.NOTION_EXPENSES_DB,
    { property: NP.EXPENSES.CONTRACTOR, relation: { contains: contractorId } },
    [{ property: NP.EXPENSES.EXPENSE_DATE, direction: 'descending' }]
  );
  if (raw.error) return raw;
  return raw.map(r => _mapExpenseProperties(r));
}

function createNotionContractor(props) {
  const C = NP.CONTRACTORS;
  const properties = {};
  properties[C.NAME] = { title: [{ text: { content: props.name } }] };
  if (props.email)         properties[C.EMAIL]          = { email: props.email };
  if (props.phone)         properties[C.PHONE]          = { phone_number: props.phone };
  if (props.type)          properties[C.TYPE]           = { select: { name: props.type } };
  if (props.roles && props.roles.length) {
    properties[C.ROLES] = { multi_select: props.roles.map(function(r) { return { name: r }; }) };
  }
  if (props.paymentMethod) properties[C.PAYMENT_METHOD] = { select: { name: props.paymentMethod } };
  if (props.isPartner !== undefined) properties[C.IS_PARTNER] = { checkbox: !!props.isPartner };
  if (props.w9Url) properties[C.W9]    = { url: props.w9Url };
  if (props.notes) properties[C.NOTES] = { rich_text: [{ text: { content: props.notes } }] };
  return _notionCreatePage(CONFIG.NOTION_CONTRACTORS_DB, properties);
}

function updateContractorInfo(contractorId, props) {
  const C = NP.CONTRACTORS;
  const properties = {};
  if (props.name !== undefined)          properties[C.NAME]           = { title: [{ text: { content: props.name } }] };
  if (props.email !== undefined)         properties[C.EMAIL]          = props.email ? { email: props.email } : { email: null };
  if (props.phone !== undefined)         properties[C.PHONE]          = props.phone ? { phone_number: props.phone } : { phone_number: null };
  if (props.type !== undefined)          properties[C.TYPE]           = { select: { name: props.type } };
  if (props.roles !== undefined)         properties[C.ROLES]          = { multi_select: props.roles.map(function(r) { return { name: r }; }) };
  if (props.paymentMethod !== undefined) properties[C.PAYMENT_METHOD] = { select: { name: props.paymentMethod } };
  if (props.isPartner !== undefined)     properties[C.IS_PARTNER]     = { checkbox: !!props.isPartner };
  if (props.w9Url !== undefined)         properties[C.W9]             = props.w9Url ? { url: props.w9Url } : { url: null };
  if (props.notes !== undefined)         properties[C.NOTES]          = { rich_text: [{ text: { content: props.notes || '' } }] };
  return _notionUpdatePage(contractorId, properties);
}

/**
 * Fetch contractor + linked expenses in two phases.
 * Phase 1: GET contractor. Phase 2: Batch expenses query.
 */
function _batchGetContractorDetails(contractorId) {
  var contractor = null;
  try {
    var raw = _notionGet('pages/' + contractorId);
    contractor = _mapContractorProperties(raw);
  } catch (e) {
    Logger.log('_batchGetContractorDetails: fetch error: ' + e.message);
    return { contractor: null, expenses: [] };
  }

  var expensesFilter = { property: NP.EXPENSES.CONTRACTOR, relation: { contains: contractorId } };
  var expensesSorts  = [{ property: NP.EXPENSES.EXPENSE_DATE, direction: 'descending' }];

  var results = _notionBatchRequest([
    { method: 'post', endpoint: 'databases/' + CONFIG.NOTION_EXPENSES_DB + '/query',
      payload: { filter: expensesFilter, sorts: expensesSorts, page_size: 100 } },
  ]);

  var expenses = _parseBatchQueryResult(results[0], _mapExpenseProperties,
    CONFIG.NOTION_EXPENSES_DB, expensesFilter, expensesSorts);

  return { contractor: contractor, expenses: expenses };
}


// ── Batch Detail Queries ────────────────────────────────────

/**
 * Fetch client + contacts + projects + invoices in a single parallel batch.
 * Returns { client, contacts, projects, invoices } with mapped properties.
 */
function _batchGetClientDetails(clientId) {
  var contactsFilter = { property: NP.CONTACTS.CLIENT, relation: { contains: clientId } };
  var contactsSorts  = [{ property: NP.CONTACTS.NAME, direction: 'ascending' }];
  var projectsFilter = { and: [
    { property: NP.PROJECTS.CLIENT, relation: { contains: clientId } },
    { or: [
      { property: NP.PROJECTS.STATUS, select: { equals: 'Active' } },
      { property: NP.PROJECTS.STATUS, select: { equals: 'Draft' } },
      { property: NP.PROJECTS.STATUS, select: { equals: 'Paused' } },
    ]}
  ]};
  var projectsSorts  = [{ property: NP.PROJECTS.NAME, direction: 'ascending' }];
  var invoicesFilter = { property: NP.INVOICES.CLIENT, relation: { contains: clientId } };
  var invoicesSorts  = [{ property: NP.INVOICES.ISSUED_DATE, direction: 'descending' }];

  var results = _notionBatchRequest([
    { method: 'get', endpoint: 'pages/' + clientId },
    { method: 'post', endpoint: 'databases/' + CONFIG.NOTION_CONTACTS_DB + '/query',
      payload: { filter: contactsFilter, sorts: contactsSorts, page_size: 100 } },
    { method: 'post', endpoint: 'databases/' + CONFIG.NOTION_PROJECTS_DB + '/query',
      payload: { filter: projectsFilter, sorts: projectsSorts, page_size: 100 } },
    { method: 'post', endpoint: 'databases/' + CONFIG.NOTION_INVOICES_DB + '/query',
      payload: { filter: invoicesFilter, sorts: invoicesSorts, page_size: 100 } },
  ]);

  var client = null;
  if (results[0] && !results[0].error) {
    try { client = _mapClientProperties(results[0]); } catch (e) {
      Logger.log('_batchGetClientDetails: client map error: ' + e.message);
    }
  }

  var contacts = _parseBatchQueryResult(results[1], _mapContactProperties,
    CONFIG.NOTION_CONTACTS_DB, contactsFilter, contactsSorts);
  var projects = _parseBatchQueryResult(results[2], _mapProjectProperties,
    CONFIG.NOTION_PROJECTS_DB, projectsFilter, projectsSorts);
  var invoices = _parseBatchQueryResult(results[3], _mapInvoiceProperties,
    CONFIG.NOTION_INVOICES_DB, invoicesFilter, invoicesSorts);

  return { client: client, contacts: contacts, projects: projects, invoices: invoices };
}

/**
 * Fetch project + invoices + agreements + client name in two phases.
 * Phase 1: GET project (sequential — needed to extract clientId).
 * Phase 2: Batch invoices + agreements + client page in parallel.
 */
function _batchGetProjectDetails(projectId) {
  // Phase 1: get project
  var project = null;
  try {
    var raw = _notionGet('pages/' + projectId);
    project = _mapProjectProperties(raw);
  } catch (e) {
    Logger.log('_batchGetProjectDetails: project fetch error: ' + e.message);
    return { project: null, invoices: [], agreements: [], clientName: '' };
  }

  // Phase 2: batch remaining queries
  var invoicesFilter   = { property: NP.INVOICES.PROJECT,   relation: { contains: projectId } };
  var invoicesSorts    = [{ property: NP.INVOICES.ISSUED_DATE, direction: 'descending' }];
  var agreementsFilter = { property: NP.AGREEMENTS.PROJECT, relation: { contains: projectId } };
  var agreementsSorts  = [{ property: NP.AGREEMENTS.EFFECTIVE_DATE, direction: 'descending' }];

  var specs = [
    { method: 'post', endpoint: 'databases/' + CONFIG.NOTION_INVOICES_DB + '/query',
      payload: { filter: invoicesFilter, sorts: invoicesSorts, page_size: 100 } },
    { method: 'post', endpoint: 'databases/' + CONFIG.NOTION_AGREEMENTS_DB + '/query',
      payload: { filter: agreementsFilter, sorts: agreementsSorts, page_size: 100 } },
  ];
  if (project.clientId) {
    specs.push({ method: 'get', endpoint: 'pages/' + project.clientId });
  }

  var results = _notionBatchRequest(specs);

  var invoices = _parseBatchQueryResult(results[0], _mapInvoiceProperties,
    CONFIG.NOTION_INVOICES_DB, invoicesFilter, invoicesSorts);
  var agreements = _parseBatchQueryResult(results[1], _mapAgreementProperties,
    CONFIG.NOTION_AGREEMENTS_DB, agreementsFilter, agreementsSorts);

  var client = null;
  var clientName = '';
  if (project.clientId && results[2] && !results[2].error) {
    try {
      client = _mapClientProperties(results[2]);
      clientName = client.name || '';
    } catch (e) {
      Logger.log('_batchGetProjectDetails: client map error: ' + e.message);
    }
  }

  return { project: project, invoices: invoices, agreements: agreements, clientName: clientName, client: client };
}
