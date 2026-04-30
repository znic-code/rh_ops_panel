// ── CONFIGURATION ────────────────────────────────────────────
// Road Hazards Ops Backend
// Secrets (NOTION_TOKEN, API_SECRET) are stored in Project Settings
// → Script Properties. Non-secret IDs are inline.

const _props = PropertiesService.getScriptProperties();
const CONFIG = {
  // ── Secrets (Script Properties) ────────────────────────────
  NOTION_TOKEN: _props.getProperty('NOTION_TOKEN'),
  API_SECRET:   _props.getProperty('API_SECRET'),

  // ── Invoice Template ───────────────────────────────────────
  TEMPLATE_ID:       '1HST03q55rxiG7FNllCdfLtSp5y9tQ4qzQFfaWs2Ttfc',  // Invoice v2 template doc
  QUOTE_TEMPLATE_ID: '1l6aidc7730d9CeIR8lUv_CX3yXbSSoVkts-TuDbGAR8',  // Quote template doc

  // ── Notion Database IDs (page IDs used by the API) ─────────
  NOTION_CLIENTS_DB:    'ef0d98cd864049398d057f3d582849e6',
  NOTION_CONTACTS_DB:   '79b39e03c1b745c6b489f1e08843b25a',
  NOTION_PROJECTS_DB:   'a8da783782764d04b229234a7955c980',
  NOTION_AGREEMENTS_DB: '1aa5678146b3400eb68abde3ae4258bd',
  NOTION_INVOICES_DB:   'f68c5b15cd0e4bf58df9dd105e759b00',
  NOTION_EXPENSES_DB:   'bb437c36f2c9470cb6b3d168fe9de8f8',
  NOTION_PAYMENTS_DB:     '754892c054954cb0a9b736067a118e08',
  NOTION_CONTRACTORS_DB:  'bafd8558045a4ec390b70629fc735771',
  NOTION_QUOTES_DB:       'b5ee87f476914741b164d975b7da9531',

  // ── Drive Folder IDs ───────────────────────────────────────
  CLIENTS_DRIVE_ROOT:   '1CQQc9QvtUhX2oFUYE1B18cEQ0gsLfBP3',  // 03_Clients/
  ASSETS_DRIVE_ROOT:    '1NTAtqp-sYf4-7fwzF7iM1VEfQQbvDzFv',  // 02_Assets/
  FINANCIALS_DRIVE_DIR: '11cWiN5XHU5giuoeOSmcqIEvBi0VJRkPo',  // 01_Admin/Financials/
  LEGAL_CONTRACTS_DIR:  '153tDQQJMSNSHQuFDLucF2295sriMapgn',  // 02_Assets/Legal/Contracts/
  LEGAL_INVOICES_DIR:   '1FXDPwkmVgUUclNrfCpenvXLCpGQTQ6tP',  // 02_Assets/Legal/Invoices/

  // ── Client Folder Subfolders ───────────────────────────────
  CLIENT_SUBFOLDERS: ['Proposals', 'Assets', 'Invoices', 'Quotes', 'Contracts', 'Projects', 'Meeting Notes', 'Expenses', 'Payments'],

  // ── Company Info ───────────────────────────────────────────
  COMPANY_NAME:    'Road Hazards Media',
  COMPANY_EMAIL:   'hello@roadhazardsmedia.com',
  COMPANY_ADDRESS: '763 Calle Vesta, San Juan, PR 00923',
  COMPANY_PHONE:   '+1 (787) 607-4678',

};

/**
 * Returns company info, preferring Script Properties over hardcoded CONFIG values.
 * Script Properties keys: company_name, company_email, company_address, company_phone
 * This lets the Settings page update company info without a code deployment.
 */
function getCompanyInfo() {
  var sp = PropertiesService.getScriptProperties();
  return {
    name:    sp.getProperty('company_name')    || CONFIG.COMPANY_NAME,
    email:   sp.getProperty('company_email')   || CONFIG.COMPANY_EMAIL,
    address: sp.getProperty('company_address') || CONFIG.COMPANY_ADDRESS,
    phone:   sp.getProperty('company_phone')   || CONFIG.COMPANY_PHONE,
  };
}

// ── Notion Property Name Constants ───────────────────────────
// Single source of truth for every Notion property name used by the panel.
// Reference these constants everywhere instead of inline string literals so
// that a Notion property rename only requires changing one line here.
//
// How to use in NotionService.js:
//   Read : p[NP.PAYMENTS.AMOUNT]?.number ?? 0
//   Write: var props = {}; props[NP.PAYMENTS.AMOUNT] = { number: val };
//   Filter: { property: NP.INVOICES.STATUS, select: { equals: 'Paid' } }
//
const NP = {
  CLIENTS: {
    NAME:              'Name',
    TYPE:              'Type',
    STATUS:            'Status',
    PRIMARY_CONTACT:   'Primary Contact',
    BILLING_STREET:    'Billing Street',
    BILLING_CITY:      'Billing City',
    BILLING_STATE:     'Billing State',
    BILLING_ZIP:       'Billing ZIP',
    BILLING_COUNTRY:   'Billing Country',
    BILLING_EMAIL:     'Billing Email',
    PHONE:             'Phone',
    WEBSITE:           'Website',
    DRIVE_FOLDER_ID:   'Drive Folder ID',
    NOTES:             'Notes',
    WITHHOLDING_AGENT: 'Withholding Agent',
    WITHHOLDING_RATE:  'Withholding Rate',
  },
  CONTACTS: {
    NAME:   'Name',
    CLIENT: 'Client',
    ROLE:   'Role',
    EMAIL:  'Email',
    PHONE:  'Phone',
    NOTES:  'Notes',
  },
  PROJECTS: {
    NAME:       'Name',
    CLIENT:     'Client',
    TYPE:       'Type',
    STATUS:     'Status',
    START_DATE: 'Start Date',
    END_DATE:   'End Date',
    NOTES:      'Notes',
  },
  AGREEMENTS: {
    TITLE:          'Title',
    DOC_TYPE:       'Doc Type',
    STATUS:         'Status',
    CLIENT:         'Client',
    PROJECT:        'Project',
    EFFECTIVE_DATE: 'Effective Date',
    SIGNED_DATE:    'Signed Date',
    FILE_URL:       'File URL',
    NOTES:          'Notes',
  },
  INVOICES: {
    INVOICE_ID:   'Invoice ID',
    TYPE:         'Type',
    STATUS:       'Status',
    CLIENT:       'Client',
    PROJECT:      'Project',
    AGREEMENT:    'Agreement',
    ISSUED_DATE:  'Issued Date',
    DUE_DATE:     'Due Date',
    PAID_DATE:    'Paid Date',
    PERIOD_MONTH: 'Period Month',
    SUBTOTAL:     'Subtotal',
    TAX:          'Tax',
    TOTAL:        'Total',
    LINE_ITEMS:   'Line Items',
    DRIVE_LINK:   'Google Drive Link',
    NOTES:        'Notes',
  },
  EXPENSES: {
    EXPENSE_ID:   'Expense ID',
    DESCRIPTION:  'Description',
    TYPE:         'Type',
    PROJECT:      'Project',
    CLIENT:       'Client',
    CONTRACTOR:   'Contractor',
    INVOICE:      'Invoice',
    CATEGORY:     'Category',
    AMOUNT:       'Amount',
    EXPENSE_DATE: 'Expense Date',
    VENDOR:       'Vendor',
    BILLABLE:     'Billable',
    RECEIPT_URL:  'Receipt URL',
    STATUS:       'Status',
    NOTES:        'Notes',
  },
  PAYMENTS: {
    PAYMENT_ID:      'Payment ID',
    DESCRIPTION:     'Description',
    INVOICE:         'Invoice',
    CLIENT:          'Client',
    AMOUNT:          'Amount',
    AMOUNT_WITHHELD: 'Amount Withheld',
    METHOD:          'Method',
    PAYMENT_DATE:    'Payment Date',
    STATUS:          'Status',
    RECEIPT_URL:     'Receipt URL',
    NOTES:           'Notes',
  },
  CONTRACTORS: {
    NAME:           'Name',
    EMAIL:          'Email',
    PHONE:          'Phone',
    TYPE:           'Type',
    ROLES:          'Roles',
    PAYMENT_METHOD: 'Payment Method',
    IS_PARTNER:     'Is Partner',
    W9:             'W-9',
    NOTES:          'Notes',
  },
  QUOTES: {
    QUOTE_ID:          'Quote ID',
    STATUS:            'Status',
    CLIENT:            'Client',
    PROJECT:           'Project',
    CONVERTED_INVOICE: 'Converted Invoice',
    ISSUED_DATE:       'Issued Date',
    VALID_UNTIL:       'Valid Until',
    SUBTOTAL:          'Subtotal',
    TAX:               'Tax',
    TOTAL:             'Total',
    LINE_ITEMS:        'Line Items',
    DRIVE_LINK:        'Google Drive Link',
    NOTES:             'Notes',
  },
};
