# RH Ops Panel — Technical Reference

> Road Hazards Media Operations Panel
> Google Apps Script Web Application
> Script ID: `1TTJphmlWIV08wrhCcRo3vjIoSIQXJhJJblNLQxB9OHG_ehIQs1ojnG0J`

---

## Architecture Overview

The app follows a **four-layer architecture**:

```
panel.html (Frontend SPA)
    ↓ google.script.run
Main.js (Orchestration — panel* functions, caching, triggers)
    ↓
Service Files (Business logic — ClientService, InvoiceService, etc.)
    ↓
NotionService.js (Data access — all Notion API calls)
```

**Frontend** → Single-page app in `panel.html` with stack-based navigation. All views render into `$('content')`.
**Backend** → `Main.js` exposes `panel*()` functions callable from the frontend. These orchestrate service calls, manage caching, and handle error responses.
**Data Layer** → `NotionService.js` handles all Notion API communication with retry logic, pagination, and batch requests.
**External Services** → Google Drive (file storage), Gmail (email drafts/sends), Google Sheets (backups/exports).

---

## Frontend (panel.html)

### Navigation System

| Function | Description |
|---|---|
| `navigate(view, title, data)` | Push current view onto the nav stack and render a new view. |
| `goBack()` | Pop the nav stack and render the previous view. |
| `navigateToRoot(view, title)` | Clear the nav stack and render a root view (dashboard, clients, projects, etc.). |
| `render()` | Master dispatcher — reads `currentView.view` and calls the appropriate render function via a switch statement. |
| `updateSidebarActive()` | Highlights the current root section in the sidebar navigation. |

**Navigation stack:** Views are pushed/popped like a browser history. Root views (dashboard, clients, projects, reports, settings, help) clear the stack. Detail views (client, project, invoice, agreement) push onto it.

### Utility Functions

| Function | Description |
|---|---|
| `$(id)` | Shorthand for `document.getElementById(id)`. |
| `esc(str)` | HTML-escape a string for safe innerHTML insertion. |
| `jsEsc(str)` | Escape single quotes for use inside JS string literals in HTML. |
| `formatMoney(n)` | Format a number as `$1,234.56`. |
| `formatDate(iso)` | Format an ISO date as `Mar 15, 2026`. |
| `showError(msg)` | Render an error message in the content area. |
| `showLoading(msg)` | Render a spinner with a loading message. |
| `detailRow(label, value, isHtml)` | Build a label-value row for detail cards. |
| `sortableTh(label, col, sortState, toggleFn, extraClass)` | Build a sortable table header cell with arrow indicators. |
| `buildStatusSelect(current, options, entityType, entityId)` | Build an inline status dropdown that auto-saves on change. |
| `onStatusChange(entityType, entityId, newStatus)` | Handle status dropdown changes — calls the appropriate `panelUpdate*Status()` backend. |
| `getInvoiceGeneratorUrl()` | Returns the published webapp URL for the invoice generator form. |

### Dashboard

| Function | Backend Call | Description |
|---|---|---|
| `renderDashboard()` | `panelGetDashboardData()` | Renders stat cards (Revenue, Outstanding, Overdue, Profit), quick-action buttons, active projects table, recent invoices, overdue invoices, and monthly revenue bar chart. |

**Backend logic:** `panelGetDashboardData()` uses a dual-fetch strategy — time-bounded queries (fiscal year) for historical data + status-bounded queries (all Sent/Overdue) for outstanding amounts. Results are merged and deduped by ID. Data is cached for 5 minutes.

### Clients

| Function | Backend Call | Description |
|---|---|---|
| `renderClients()` | `panelGetAllClients()` | Renders the clients list with stat cards, search, type filter, and sortable table. Adds "+ New Client" button to the top bar. |
| `filterClientList()` | — | Client-side filtering of cached clients by type and search text. |
| `toggleClientSort(col)` | — | Toggle sort direction on a column and re-filter. |
| `renderClientView(clientId)` | `panelGetClientDetails(clientId)` | Renders client detail: info card, contacts list, projects table, and action buttons (Edit, Archive). |
| `renderNewClientForm()` | — | Renders the new client creation form with contact and project fields. |
| `submitNewClient()` | `panelCreateClient(data)` | Validates and submits the new client form. |
| `renderEditClientForm(clientId)` | `panelGetClientDetails(clientId)` | Renders the edit form pre-filled with client data. |
| `submitEditClient(clientId)` | `panelUpdateClientInfo(clientId, data)` | Submits client edits. |
| `confirmArchiveClient(clientId, name)` | `panelArchiveClient(clientId)` | Confirmation dialog → sets status to "Archived". Navigates to clients list on success. |

**Backend logic:** `panelCreateClient()` → `createFullClient()` in ClientService.js. This is a multi-step operation protected by LockService: creates Notion client page → creates Drive folder structure → creates contact(s) → optionally creates a project. Rolls back on failure.

### Projects

| Function | Backend Call | Description |
|---|---|---|
| `renderProjects()` | `panelGetAllProjects()` | Renders projects list with stat cards, search, status/type filters, sortable table. Adds "+ New Project" to top bar. |
| `filterProjectList()` | — | Client-side filtering by status, type, and search text. |
| `toggleProjectSort(col)` | — | Toggle sort direction and re-filter. |
| `renderProjectView(projectId, clientId)` | `panelGetProjectDetails(projectId)` | Renders project detail: stat cards, details card (with Edit/Archive/Delete buttons), recurring billing config (for Retainer projects), invoices table (with + Create and Generate buttons), agreements table. |
| `renderNewProjectForm(clientId)` | `getClients()` | Renders new project form. Shows client dropdown if no clientId provided (when accessed from Projects list). |
| `submitNewProject(clientId)` | `panelCreateProject(data)` | Validates and submits. Resolves clientId from dropdown if not pre-selected. |
| `renderEditProjectForm(projectId)` | `panelGetProjectDetails(projectId)` | Edit form pre-filled with project data. |
| `submitEditProject(projectId)` | `panelUpdateProjectInfo(projectId, data)` | Submits project edits. |
| `confirmArchiveProject(projectId, name)` | `panelArchiveProject(projectId)` | Sets status to "Archived". |
| `confirmDeleteProject(projectId, name)` | `panelDeleteProject(projectId)` | Moves to Notion trash (recoverable 30 days). |

**Backend logic:** `panelCreateProject()` → `createProject()` in ProjectService.js. Protected by LockService. Creates the Notion page with client relation.

### Quick-Create Invoice (on Project Detail)

| Function | Backend Call | Description |
|---|---|---|
| `toggleCreateInvoiceForm()` | — | Show/hide the inline invoice creation form card. Scrolls to form and adds first line item. |
| `addQuickLineItem()` | — | Adds a line item row (name, description, qty, price). |
| `removeQuickLineItem(n)` | — | Removes a line item row and recalculates totals. |
| `updateQuickTotals()` | — | Recalculates subtotal, tax, and total from current line items. |
| `updateQuickDueDate()` | — | Sets due date to issue date + 14 days. |
| `getQuickLineItems()` | — | Collects all line items from the form into an array. |
| `submitQuickInvoice(clientId, projectId)` | `panelQuickCreateInvoice(data)` | Submits the form. Reloads project view on success to show new invoice. |

**Backend logic:** `panelQuickCreateInvoice()` fetches full client billing info server-side (the panel only sends clientId + line items), builds the complete invoice data object, and calls `generateInvoice()` in InvoiceService.js. This generates a Google Doc from the template → exports as PDF → saves to Drive (in year subfolder) → logs to Notion.

### Invoices

| Function | Backend Call | Description |
|---|---|---|
| `renderInvoiceView(invoiceId, clientId)` | `panelGetInvoiceDetails(invoiceId)` | Renders invoice detail: stat cards (Total/Paid/Balance), payment progress bar, invoice details card (with Delete button), line items, payments table, and log payment form. |
| `submitLogPayment(invoiceId, clientId)` | `panelLogPayment(data)` | Logs a payment and optionally marks invoice as Paid. Reloads invoice view on success. |
| `confirmDeleteInvoice(id, num, driveLink)` | `panelDeleteInvoice(id, driveLink)` | Trashes the Notion page and the Drive PDF. Navigates to dashboard. |

**Backend logic:** `panelLogPayment()` creates a Notion payment record linked to the invoice and client. If "Mark as Paid" is checked, also updates invoice status to Paid with today's date.

### Agreements

| Function | Backend Call | Description |
|---|---|---|
| `renderAgreementView(agreementId, clientId)` | `panelGetAgreementDetails(agreementId)` | Renders agreement detail with all fields and action buttons. |
| `renderNewAgreementForm(projectId, clientId)` | — | Form for creating a new agreement linked to a project. |
| `submitNewAgreement(projectId, clientId)` | `panelCreateAgreement(data)` | Creates Notion agreement page with project/client relations. |
| `renderEditAgreementForm(agreementId)` | `panelGetAgreementById(agreementId)` | Edit form pre-filled with agreement data. |
| `submitEditAgreement(agreementId)` | `panelUpdateAgreementInfo(agreementId, data)` | Submits agreement edits. |

### Email Composition

| Function | Backend Call | Description |
|---|---|---|
| `openComposeEmail(entityType, entityId, documentId, clientId, extra)` | — | Navigates to compose view with entity metadata packaged into nav data. |
| `renderComposeView(data)` | `panelGetComposeData(entityType, entityId, clientId)` | Renders email compose form with template selection, pre-filled subject/body, and CC/BCC fields. |
| `onComposeTemplateChange()` | — | Swaps the subject/body when user selects a different template. |
| `submitComposeEmail()` | `panelComposeEmail(data)` | Sends or drafts the email via Gmail. |
| `draftInvoiceEmail(invoiceId, ...)` | `panelGetComposeData(...)` | Shortcut to compose an invoice email. |
| `draftAgreementEmail(agreementId, ...)` | `panelGetComposeData(...)` | Shortcut to compose an agreement email. |

**Backend logic:** `panelComposeEmail()` → `createDocumentDraft()` in GmailService.js. Resolves the template, replaces `{{variables}}`, processes conditional blocks `{{#var}}...{{/var}}`, attaches Drive files, and creates a Gmail draft or sends directly.

### Expenses

| Function | Backend Call | Description |
|---|---|---|
| `renderExpenses()` | `panelGetAllExpenses()` | Renders expenses list with stat cards, search, category/type filters, and sortable table. Adds "+ Log Expense" button to top bar. |
| `filterExpenseList()` | — | Client-side filtering of cached expenses by category, type, and search text. Filter-aware empty states. |
| `toggleExpenseSort(col)` | — | Toggle sort direction and re-filter. |
| `renderExpenseView(expensePageId)` | `panelGetExpenseById(expensePageId)` | Renders expense detail: stat cards (Amount, Category, Status), details card with Edit/Delete buttons, linked client/project/contractor, receipt link. |
| `renderNewExpenseForm(data)` | — | Renders the expense form with receipt upload zone, Google Picker button, client/project/contractor dropdowns, and all expense fields. Wrapped in `form-card`. |
| `renderEditExpenseForm(expensePageId)` | `panelGetExpenseById(expensePageId)` | Edit form pre-filled with expense data. Dynamically loads client/project/contractor dropdowns. |
| `_loadExpenseDropdowns(data)` | `panelGetClients()`, `panelGetAllProjects()`, `panelGetAllContractors()` | Populates client, project, and contractor dropdowns. Filters projects by selected client. |
| `_loadEditExpenseDropdowns(...)` | Same as above | Populates dropdowns for the edit form with pre-selected values. |
| `submitEditExpense(expensePageId)` | `panelUpdateExpense(expensePageId, data)` | Submits expense edits. If client changed, backend moves receipt file to new client folder. |
| `confirmArchiveExpense(expensePageId, label)` | `panelArchiveExpense(expensePageId)` | Confirmation dialog → deletes expense from Notion + trashes associated Drive receipt file. |
| `onExpenseClientChange()` | — | Filters projects dropdown by client. Auto-sets type to "Project" or "Overhead". |
| `onReceiptFileSelected()` | — | Validates file size (10MB limit), stores file in browser memory, shows Extract button. |
| `uploadAndExtractReceipt()` | `panelUploadAndExtractReceipt(data)` | Reads file as base64 → uploads to staging → runs AI extraction (expense context) → fills form fields. |
| `onReceiptProcessed(result)` | — | Handles upload+extraction result — stores file ID/URL, fills form fields, shows receipt preview link. Shared by upload and Picker flows. |
| `_applyExtractedData(d)` | — | Fills form fields (description, vendor, amount, date, category, notes) from extracted data. |
| `retryExtraction()` | `panelReExtractReceipt(fileId, 'expense')` | Re-runs AI extraction on an already-uploaded receipt without re-uploading. |
| `openDrivePicker()` | `panelGetPickerConfig()` | Fetches Picker config (API key, App ID, OAuth token) → loads Google Picker API → opens file picker filtered to images/PDFs. |
| `onPickerCallback(data)` | `panelPickerExtractReceipt(data)` | Handles Picker selection — extracts from the original file, holds reference until submit. |
| `submitNewExpense()` | `panelLogExpenseFromReceipt(data)` | Validates form. Backend pre-generates expense ID (RH-EXP-YY-MMDD-##), moves/copies receipt to correct folder renamed to match ID, then logs to Notion. |

**Backend logic:** Receipt upload uses a **staging pattern** — file uploads to `_Staging/` folder, then moves to final folder on submit. The ID is pre-generated before the file move so the receipt is renamed to match (e.g., `RH-EXP-26-0320-01.pdf`). If client changes on edit, `panelUpdateExpense()` detects the change and moves the receipt to the new client's folder. Deletion via `panelArchiveExpense()` also trashes the Drive receipt file. AI extraction uses a dedicated **expense prompt** that focuses on vendor, category, line items, and billable indicators.

### Payments

| Function | Backend Call | Description |
|---|---|---|
| `renderPayments()` | `panelGetAllPayments()` | Renders payments list with stat cards, search, method/status filters, and sortable table. Adds "+ Log Payment" to top bar. |
| `filterPaymentList()` | — | Client-side filtering of cached payments by method, status, and search text. Filter-aware empty states. |
| `togglePaymentSort(col)` | — | Toggle sort direction and re-filter. |
| `renderPaymentView(paymentPageId)` | `panelGetPaymentById(paymentPageId)` | Renders payment detail: stat cards (Amount, Method, Status with badge), details card with Edit/Delete buttons, receipt link, linked client/invoice. |
| `renderNewPaymentForm(data)` | — | Renders payment form with receipt upload zone, Google Picker button, client/invoice dropdowns. Wrapped in `form-card`. |
| `renderEditPaymentForm(paymentPageId)` | `panelGetPaymentById(paymentPageId)` | Edit form pre-filled with payment data. Dynamically loads client/invoice dropdowns. |
| `_loadPaymentDropdowns(data)` | `panelGetClients()`, `panelGetAllInvoices()` | Populates client and invoice dropdowns. |
| `_loadEditPaymentDropdowns(...)` | Same as above | Populates dropdowns for edit form with pre-selected values. |
| `submitEditPayment(paymentPageId)` | `panelUpdatePayment(paymentPageId, data)` | Submits payment edits. If client changed, backend moves receipt file to new client folder. |
| `confirmArchivePayment(paymentPageId, label)` | `panelArchivePayment(paymentPageId)` | Confirmation dialog → deletes payment from Notion + trashes associated Drive receipt file. |
| `onPaymentReceiptFileSelected()` | — | Validates file size, stores in browser memory, shows Extract button. |
| `uploadAndExtractPaymentReceipt()` | `panelUploadAndExtractPaymentReceipt(data)` | Reads file as base64 → uploads to staging → runs AI extraction (payment context) → fills form fields. |
| `openPaymentDrivePicker()` | `panelGetPickerConfig()` | Opens Google Picker for payment receipt selection. |
| `_applyPaymentExtraction(data)` | — | Fills form fields (description, amount, date, method, reference number, invoice number) from extracted data. |
| `submitNewPayment()` | `panelLogPaymentFromReceipt(data)` | Validates form. Backend pre-generates payment ID (RH-PAY-YY-MMDD-##), moves/copies receipt renamed to match ID, then logs to Notion. |

**Backend logic:** Same staging + rename pattern as expenses. AI extraction uses a dedicated **payment prompt** that focuses on payment method, reference/confirmation numbers, invoice numbers, and payer/payee. If the AI extracts an invoice number, the backend attempts to auto-link it to a matching Notion invoice record.

### Contractors

| Function | Backend Call | Description |
|---|---|---|
| `renderContractors()` | `panelGetAllContractors()` | Renders contractor list with stat cards (Total, Partners), search, role/type filters, sortable table. Adds "+ New Contractor" to top bar. |
| `filterContractorList()` | — | Client-side filtering by role, type, and search text. Filter-aware empty states. |
| `toggleContractorSort(col)` | — | Toggle sort direction and re-filter. |
| `renderContractorView(contractorId)` | `panelGetContractorDetails(contractorId)` | Renders contractor detail: stat cards (Expenses, Total Spent), info card, linked expenses table, action buttons. |
| `renderNewContractorForm()` | — | Renders contractor creation form with W-9 upload/picker field (name, email, phone, type, roles, payment method, partner checkbox, W-9, notes). |
| `submitNewContractor()` | `panelCreateContractor(data)` | Validates and submits new contractor. |
| `renderEditContractorForm(contractorId)` | `panelGetContractorById(contractorId)` | Edit form pre-filled with contractor data including W-9 field. |
| `submitEditContractor(contractorId)` | `panelUpdateContractorInfo(contractorId, data)` | Submits contractor edits. |
| `confirmArchiveContractor(contractorId, name)` | `panelArchiveContractor(contractorId)` | Confirmation dialog → archives contractor. |
| `_w9FieldHtml(prefix, existingUrl)` | — | Renders the W-9 field with Upload + Drive Picker buttons and optional View link. Reusable across new/edit forms. |
| `onW9FileSelected(prefix)` | `panelUploadW9(data)` | Handles W-9 file upload → saves to `01_Admin/Financials/W-9s/{ContractorName} - W9.ext` → fills URL field. |
| `openW9Picker(prefix)` | `panelGetPickerConfig()` | Opens Google Picker to select existing W-9 from Drive → fills URL field. |

### Reports

| Function | Backend Call | Description |
|---|---|---|
| `renderReports()` | `panelGetFinancialReport()` | Renders financial reports: stat cards, revenue by month bar chart, profit chart (revenue vs expenses), and data export form. |
| `buildBarChart(data, containerId)` | — | Renders a pure-CSS horizontal bar chart. |
| `buildProfitChart(data, containerId)` | — | Renders a dual-bar (revenue + expenses) chart. |
| `exportFinancialData()` | `panelExportFinancialData(start, end)` | Exports financial data to a Google Sheets spreadsheet for a date range. Opens the spreadsheet on success. |

**Backend logic:** `panelGetFinancialReport()` uses the same dual-fetch strategy as the dashboard. `panelExportFinancialData()` pushes the date filter to the Notion API (no client-side filtering), creates a spreadsheet with Summary, Invoices, Expenses, and Revenue by Project sheets.

### Settings

| Function | Backend Call | Description |
|---|---|---|
| `renderSettings()` | `panelGetSettings()` | Renders settings page: Invoice Reminders card, Email Templates card, Data Backup card, System Health card. |
| `saveSettings()` | `panelSaveSettings(data)` | Saves reminder settings (enabled, daysBefore, overdueIntervals). |

#### Email Templates (Settings)

| Function | Backend Call | Description |
|---|---|---|
| `loadTemplateList()` | `panelGetEmailTemplates()` | Loads and renders all email templates with Edit/Delete/Reset buttons. |
| `toggleTemplateForm()` | — | Show/hide the template create/edit form. |
| `cancelTemplateForm()` | — | Hide the form and clear fields. |
| `editEmailTemplate(id)` | — | Populate the form with an existing template's data for editing. |
| `saveEmailTemplate()` | `panelSaveEmailTemplate(data)` | Create or update a template. |
| `deleteEmailTemplate(id, name)` | `panelDeleteEmailTemplate(id)` | Delete a custom template (with confirmation). |
| `resetEmailTemplate(id, name)` | `panelResetEmailTemplate(id)` | Reset a customized built-in template to its default. |

#### Data Backup (Settings)

| Function | Backend Call | Description |
|---|---|---|
| `loadBackupConfig()` | `panelGetBackupConfig()` | Loads backup settings (frequency, last backup, folder, spreadsheet link). |
| `saveBackupConfig()` | `panelSaveBackupConfig(config)` | Saves frequency and Drive folder. Validates folder access. Moves existing spreadsheet if folder changed. |
| `runBackupNow()` | `panelRunBackup()` | Manual backup trigger. Shows progress, displays per-table results (green/amber/red). |

**Backend logic:** `backupNotionData()` fetches all 8 Notion databases incrementally (fetch one → write one), adds a Config sheet with redacted settings, and writes a Backup Log sheet with per-table status. Each backup overwrites the same spreadsheet; Google Sheets version history provides recovery. Backup folder is selectable via Google Picker in Settings.

#### Recurring Billing (Project Detail)

| Function | Backend Call | Description |
|---|---|---|
| `loadRecurringConfig(projectId)` | `panelGetRecurringConfig(projectId)` | Loads recurring billing settings for a retainer project. |
| `toggleRecurringFields()` | — | Show/hide the recurring billing form fields based on toggle state. |
| `saveRecurringConfig(projectId)` | `panelSaveRecurringConfig(projectId, config)` | Saves recurring billing settings (enabled, amount, description, dayOfMonth, dueDays). |

#### System Health (Settings)

| Function | Backend Call | Description |
|---|---|---|
| `runHealthCheck()` | `panelHealthCheck()` | Runs comprehensive checks across all dependencies. Displays color-coded results table. |

**Backend logic:** `panelHealthCheck()` tests: Notion token validity, invoice template accessibility, 5 Drive folders, 8 Notion databases (accessible + schema validation against expected properties), 5 PropertiesService keys (JSON validity), 3 API keys (Picker, Anthropic), and trigger configuration. `panelQuickPing()` runs a lightweight subset on every page load (cached 24h) checking critical systems only.

### Help

| Function | Description |
|---|---|
| `renderHelp()` | Renders FAQ sections: Getting Started, Invoices & Payments, Agreements, Data & Reports, Administration, Troubleshooting. |
| `toggleFaq(el)` | Toggle a FAQ item open/closed. |
| `faqItem(question, answer)` | Build a collapsible FAQ item HTML block. |

### Startup

| Function | Backend Call | Description |
|---|---|---|
| `window.onload` | `panelQuickPing()` | On page load, runs a lightweight health check in parallel with dashboard render. Checks: Notion API, critical Drive folders, all databases, Claude API key. **Cached for 24 hours** — subsequent loads are instant. If issues found, shows a red banner listing specific problems with links to Settings and Dismiss. |

---

## Backend Orchestration (Main.js)

### Entry Points

| Function | Description |
|---|---|
| `doGet(e)` | Serves the panel HTML (`panel.html`) or the invoice form (`webapp.html`) based on URL parameters. Also handles API GET requests (`?page=api&action=getPickerData`) for iOS Shortcut client list fetching. |
| `doPost(e)` | API router: handles `generateInvoice` (webapp form), `quickExpense` / `quickPayment` (iOS Shortcut), and other form actions. All POST API calls require `API_SECRET` authentication. |

### Cache Management

| Function | Description |
|---|---|
| `_cacheGet(key)` | Retrieve cached value. Handles both single-key and chunked payloads (auto-reassembles chunks). |
| `_cacheSet(key, value, ttl)` | Store value in cache. Auto-chunks at 90KB boundaries if payload exceeds limit. Default TTL: 5 minutes. |
| `_cacheInvalidate(keys)` | Remove cached values including all chunk keys. Called after every write operation. |

**Cache keys:** `dashboard`, `financialReport`. These are the two expensive aggregation queries.

### Panel Functions (called from frontend)

#### Data Retrieval

| Function | Description |
|---|---|
| `panelGetDashboardData()` | Dual-fetch: fiscal year invoices/expenses + all outstanding invoices. Merges, dedupes, computes stats. Cached. |
| `panelGetFinancialReport()` | Same dual-fetch pattern. Computes monthly revenue, profit margins. Cached. |
| `panelGetAllClients()` | Returns all clients from Notion. |
| `panelGetAllProjects()` | Returns all projects with client names resolved. |
| `panelGetClientDetails(clientId)` | Batch-fetches client info, contacts, projects, invoices (uses `_notionBatchRequest` for parallel API calls). |
| `panelGetProjectDetails(projectId)` | Batch-fetches project info, invoices, agreements, and full client object. |
| `panelGetInvoiceDetails(invoiceId)` | Returns invoice with payments. |
| `panelGetAgreementDetails(agreementId)` | Returns agreement with linked invoice/client data. |
| `panelGetAgreementById(agreementId)` | Returns a single agreement for the edit form. |
| `panelGetContactById(contactId)` | Returns a single contact for the edit form. |
| `panelGetAllExpenses()` | Returns all expenses from Notion. |
| `panelGetExpenseById(expensePageId)` | Returns a single expense. |
| `panelGetAllPayments()` | Returns all payments from Notion. |
| `panelGetPaymentById(paymentPageId)` | Returns a single payment. |
| `panelGetAllContractors()` | Returns all contractors from Notion. |
| `panelGetContractorById(contractorId)` | Returns a single contractor for edit form. |
| `panelGetContractorDetails(contractorId)` | Returns contractor with linked expenses and total spent. |
| `panelGetComposeData(entityType, entityId, clientId)` | Loads entity data + available email templates for the compose view. |
| `panelGetOAuthToken()` | Returns the user's OAuth token for Google Picker. |
| `panelGetSettings()` | Returns reminder settings from PropertiesService. |
| `panelGetBackupConfig()` | Returns backup settings (frequency, spreadsheetId, lastBackup, folderId). |
| `panelGetRecurringConfig(projectId)` | Returns recurring billing config for a project. |
| `panelGetEmailTemplates()` | Returns all email templates (built-in + custom). |

#### Create Operations

| Function | Description |
|---|---|
| `panelCreateClient(data)` | Full client creation flow (Notion + Drive + contacts + optional project). LockService protected. |
| `panelCreateProject(data)` | Creates a Notion project page. LockService protected. |
| `panelCreateAgreement(data)` | Creates a Notion agreement page with client/project relations. |
| `panelAddContact(data)` | Creates a Notion contact linked to a client. |
| `panelLogExpense(data)` | Creates an expense record linked to client/project/contractor. Invalidates cache. |
| `panelLogExpenseFromReceipt(data)` | Pre-generates expense ID → moves/renames receipt to final folder → logs to Notion. Used by the receipt review form. |
| `panelLogPayment(data)` | Creates a payment record. Optionally marks invoice as Paid. |
| `panelLogPaymentFromReceipt(data)` | Pre-generates payment ID → moves/renames receipt → logs to Notion. Used by the payment receipt review form. |
| `panelUploadAndExtractReceipt(data)` | Uploads receipt to staging → runs Claude Vision extraction (expense context). Returns file info + extracted data. |
| `panelUploadAndExtractPaymentReceipt(data)` | Same, with payment extraction context. |
| `panelPickerExtractReceipt(data)` | Extracts from a Drive-picked file (expense context). |
| `panelPickerExtractPaymentReceipt(data)` | Extracts from a Drive-picked file (payment context). |
| `panelReExtractReceipt(fileId, context)` | Re-runs AI extraction on an already-uploaded receipt with specified context. |
| `panelCreateContractor(data)` | Creates a Notion contractor page. |
| `panelUploadW9(data)` | Uploads W-9 file to `01_Admin/Financials/W-9s/{ContractorName} - W9.ext`. Returns file URL. |
| `panelQuickCreateInvoice(data)` | Lightweight invoice creation from project detail — fetches client billing info server-side, calls `generateInvoice()`. |
| `panelComposeEmail(data)` | Creates a Gmail draft or sends an email with Drive attachments. |

#### Update Operations

| Function | Description |
|---|---|
| `panelUpdateClientInfo(clientId, data)` | Updates client fields in Notion. Invalidates cache. |
| `panelUpdateProjectInfo(projectId, data)` | Updates project fields. Invalidates cache. |
| `panelUpdateAgreementInfo(agreementId, data)` | Updates agreement fields. Invalidates cache. |
| `panelUpdateContactInfo(contactId, data)` | Updates contact fields. |
| `panelUpdateContractorInfo(contractorId, data)` | Updates contractor fields. |
| `panelUpdateExpense(expensePageId, data)` | Updates expense fields. If client changed, moves receipt file to new client folder. |
| `panelUpdatePayment(paymentPageId, data)` | Updates payment fields. If client changed, moves receipt file to new client folder. |
| `panelSetPrimaryContact(clientId, contactId)` | Sets the Primary Contact relation on the client record. |
| `panelUpdateClientStatus(clientId, status)` | Sets client status. Invalidates cache. |
| `panelUpdateProjectStatus(projectId, status)` | Sets project status. Invalidates cache only on success. |
| `panelUpdateInvoiceStatus(invoiceId, status)` | Sets invoice status. Auto-sets paidDate if status is "Paid". |
| `panelUpdateAgreementStatus(agreementId, status)` | Sets agreement status. |
| `panelSaveSettings(data)` | Saves reminder settings to PropertiesService. |
| `panelSaveBackupConfig(config)` | Saves backup frequency and Drive folder. Validates folder. Moves spreadsheet if folder changed. |
| `panelSaveRecurringConfig(projectId, config)` | Saves recurring billing config for a project. |
| `panelSaveEmailTemplate(data)` | Creates or updates an email template. |

#### Delete Operations

| Function | Description |
|---|---|
| `panelArchiveClient(clientId)` | Sets client status to "Archived". |
| `panelArchiveProject(projectId)` | Sets project status to "Archived". |
| `panelDeleteProject(projectId)` | Moves project to Notion trash. |
| `panelDeleteInvoice(invoicePageId, driveLink)` | Trashes Notion page + Drive PDF. |
| `panelArchiveExpense(expensePageId)` | Archives Notion expense + trashes associated Drive receipt file. |
| `panelArchivePayment(paymentPageId)` | Archives Notion payment + trashes associated Drive receipt file. |
| `panelArchiveContractor(contractorId)` | Archives contractor in Notion. |
| `panelArchiveContact(contactId)` | Archives contact in Notion. |
| `panelDeleteEmailTemplate(id)` | Deletes a custom email template. |
| `panelResetEmailTemplate(id)` | Resets a customized built-in template. |

#### Backup & Health

| Function | Description |
|---|---|
| `panelRunBackup()` | Manual backup trigger — always runs. |
| `backupNotionData(forceRun)` | Main backup function. Fetches 8 databases incrementally (Clients, Contacts, Projects, Invoices, Agreements, Expenses, Payments, Contractors), writes to Google Sheets with human-readable name columns, adds Config + Backup Log sheets. Validates row/column consistency and skips malformed rows with logging. |
| `panelQuickPing()` | Lightweight health check on page load. Checks Notion API, critical Drive folders, all databases, Claude API key. Cached 24 hours. |
| `panelHealthCheck()` | Comprehensive health diagnostic — Notion, Drive, databases, schemas, API keys, triggers. |
| `dailyHealthCheckEmail()` | Runs full health check, emails results only if issues found. Clears cached quick ping. |
| `panelExportFinancialData(startDate, endDate)` | Exports invoices/expenses for a date range to Google Sheets. |

### iOS Shortcut API

The `doPost()` handler routes API requests from the iOS "RH Quick Log" shortcut. All API calls require `API_SECRET` for authentication.

| Endpoint (action) | Handler | Description |
|---|---|---|
| `getPickerData` (GET) | `_getShortcutPickerData()` | Returns `{ clients, clientNames, categories, paymentMethods }` for populating shortcut menus. |
| `quickExpense` (POST) | `_handleQuickExpense(body)` | Accepts base64 receipt image + optional clientId/clientName → uploads to staging → AI extraction (expense context) → pre-generates ID → moves+renames file → logs to Notion with status "Review". Returns `{ expense, notionUrl, message }`. |
| `quickPayment` (POST) | `_handleQuickPayment(body)` | Same flow for payments. AI uses payment extraction prompt. Returns `{ payment, notionUrl, message }`. |

**Shortcut flow:** Take photo → optional client selection from live list → POST with base64 image → backend processes everything → notification with result → optional "Review in Notion" deep link.

### Time-Driven Triggers

These functions are meant to be called by GAS time-driven triggers (configured in script.google.com):

| Function | Recommended Schedule | Description |
|---|---|---|
| `checkOverdueInvoices()` | Daily | Scans Sent invoices past due date, auto-marks them as Overdue. |
| `sendInvoiceReminders()` | Daily | Sends email reminders for upcoming and overdue invoices based on configured intervals. Prunes stale reminder log entries. |
| `generateRecurringInvoices()` | Daily | Generates invoices for active retainer projects based on recurring billing configs. LockService protected. Uses `_addDays()` for DST-safe date math. |
| `dailyHealthCheckEmail()` | Daily | Runs full health check. Only sends email if errors/warnings found. HTML-formatted with tables. Also clears the cached quick ping. |
| `backupNotionData(forceRun)` | Daily | Backs up all Notion databases to Google Sheets. Always runs when triggered (no frequency gate). |
| `cleanupStagingFolder()` | Daily | Deletes orphaned files in `_Staging/` older than 24 hours (receipts uploaded but never submitted). |

---

## Data Access Layer (NotionService.js)

### Core API Helpers

| Function | Description |
|---|---|
| `_notionRequest(url, options)` | Low-level HTTP call with retry logic. Retries 429/5xx errors with exponential backoff (500ms → 1s → 2s), max 3 retries. |
| `_notionFetch(endpoint, payload)` | POST request wrapper. |
| `_notionGet(endpoint)` | GET request wrapper. |
| `_notionPatch(endpoint, payload)` | PATCH request wrapper. |
| `_notionBatchRequest(specs)` | Parallel API calls using `UrlFetchApp.fetchAll()`. Used by client/project detail views. |
| `_queryAll(dbId, filter, sorts, maxResults)` | Paginated database query. 100 records per page, 2000-record ceiling, 200ms delay between pages for rate limit protection. |
| `_getDbProperties(dbId)` | Fetches database metadata and returns property names. Used by health check for schema validation. |

### Property Mappers

Each mapper converts a raw Notion page object into a clean JS object:

| Function | Returns |
|---|---|
| `_mapClientProperties(page)` | `{ id, notionUrl, name, type, status, primaryContactId, billingStreet, billingCity, billingState, billingZip, billingCountry, billingEmail, phone, website, driveFolderId, notes }` |
| `_mapContactProperties(page)` | `{ id, notionUrl, name, clientId, role, email, phone, notes }` |
| `_mapProjectProperties(page)` | `{ id, notionUrl, name, clientId, type, status, startDate, endDate, notes }` |
| `_mapInvoiceProperties(page)` | `{ id, notionUrl, invoiceId, type, status, clientId, projectId, agreementId, issuedDate, dueDate, paidDate, periodMonth, subtotal, tax, total, lineItems, driveLink, notes }` |
| `_mapAgreementProperties(page)` | `{ id, notionUrl, title, docType, status, clientId, projectId, effectiveDate, signedDate, fileUrl, notes }` |
| `_mapExpenseProperties(page)` | `{ id, notionUrl, description, expenseId, projectId, clientId, contractorId, invoicePageId, category, amount, expenseDate, vendor, billable, receiptUrl, status, notes }` |
| `_mapPaymentProperties(page)` | `{ id, notionUrl, paymentId, description, invoiceId, clientId, amount, method, paymentDate, status, receiptUrl, notes }` |
| `_mapContractorProperties(page)` | `{ id, notionUrl, name, email, phone, type, roles[], paymentMethod, isPartner, w9Url, notes }` |

### Query Functions

| Function | Description |
|---|---|
| `getClients()` | All clients (Active, Draft, Paused, Closed statuses). |
| `getClientById(clientId)` | Single client by page ID. |
| `lookupClientByName(name)` | Find client by exact name match. |
| `getContactsByClient(clientId)` | All contacts for a client. |
| `getAllContacts()` | All contacts (used by backup). |
| `getPrimaryContact(clientId)` | Reads the Primary Contact relation from the client record. Falls back to first contact. |
| `getContactById(contactId)` | Single contact by page ID. |
| `getProjects()` | All projects (Active, Draft, Paused, Closed). |
| `getProjectsByClient(clientId)` | Projects for a specific client. |
| `lookupProjectByName(name)` | Find project by exact name match. |
| `getAgreementsByProject(projectId)` | Agreements for a project. |
| `getAllAgreements()` | All agreements (used by backup). |
| `getInvoicesByProject(projectId)` | Invoices for a project. |
| `getAllInvoices()` | All invoices (used by backup). |
| `getInvoicesByStatus(statuses)` | Invoices filtered by status array (e.g., ['Sent', 'Overdue']). |
| `getInvoicesByDateRange(start, end)` | Invoices within a date range (Issued Date). |
| `getSentInvoicesDueBefore(date)` | Sent invoices with due date before a given date. |
| `getExpensesByProject(projectId)` | Expenses for a project. |
| `getAllExpenses()` | All expenses (used by backup). |
| `getExpensesByDateRange(start, end)` | Expenses within a date range (Expense Date). |
| `getPaymentsByInvoice(invoiceId)` | Payments for an invoice. |
| `getAllPayments()` | All payments (used by backup). |
| `getExpenseById(expensePageId)` | Single expense by page ID. |
| `updateExpenseInfo(expensePageId, props)` | Updates expense properties. |
| `getUnInvoicedBillableExpenses(clientId)` | Fetches billable expenses not yet linked to an invoice. |
| `markExpensesAsInvoiced(expensePageIds, invoicePageId)` | Links expenses to an invoice via the Invoice relation. |
| `getPaymentById(paymentPageId)` | Single payment by page ID. |
| `updatePaymentInfo(paymentPageId, props)` | Updates payment properties. |
| `getAllContractors()` | All contractors sorted by name. |
| `getContractorById(contractorId)` | Single contractor by page ID. |
| `getExpensesByContractor(contractorId)` | Expenses linked to a contractor. |

### Batch Detail Fetchers

| Function | Description |
|---|---|
| `_batchGetClientDetails(clientId)` | Parallel fetch: client page + projects + invoices + contacts + agreements. Single round-trip via `_notionBatchRequest`. |
| `_batchGetProjectDetails(projectId)` | Parallel fetch: project page + invoices + agreements + client. Returns full client object for quick-create invoice. |

### Create / Update / Delete

| Function | Description |
|---|---|
| `createNotionClient(props)` | Creates a client page in Notion. |
| `updateClientInfo(clientId, props)` | Updates client properties. |
| `updateClientDriveFolderId(clientId, folderId)` | Sets the Drive Folder ID property. |
| `createNotionContact(props)` | Creates a contact linked to a client. |
| `updateContactInfo(contactId, props)` | Updates contact properties. |
| `createNotionProject(props)` | Creates a project linked to a client. |
| `updateProjectInfo(projectId, props)` | Updates project properties. |
| `setProjectStatus(projectId, status)` | Validates and sets project status. |
| `createNotionAgreement(props)` | Creates an agreement linked to client/project. |
| `updateAgreementInfo(agreementId, props)` | Updates agreement properties. |
| `createNotionInvoice(props)` | Creates an invoice page. |
| `updateInvoiceStatus(invoiceId, status, paidDate)` | Sets invoice status and optionally paid date. |
| `logToNotion(invoiceId, data, driveUrl)` | Creates an invoice record with line items summary. Called by `generateInvoice()`. |
| `createNotionExpense(props)` | Creates an expense record. |
| `createNotionPayment(props)` | Creates a payment record. |
| `createNotionContractor(props)` | Creates a contractor page. |
| `updateContractorInfo(contractorId, props)` | Updates contractor properties. |
| `_batchGetContractorDetails(contractorId)` | Fetches contractor + linked expenses. |
| `archiveNotionPage(pageId)` | Moves any page to Notion trash (sets `archived: true`). |

---

## Service Files

### InvoiceService.js

| Function | Description |
|---|---|
| `generateInvoice(data)` | Full invoice generation pipeline: get next ID → resolve Drive folder (with year subfolder) → copy Google Doc template → fill placeholders → fill line items table → format totals → export as PDF → trash Doc copy → log to Notion. |
| `fillLineItemRow(table, rowIndex, item)` | Fills a single row in the line items table (name, description bullets, qty, price, total). |
| `removeBlankClientRows(table)` | Removes rows where optional client fields (phone, email, website) are blank. |
| `formatBillingAddress(data)` | Formats billing address as a single comma-separated line. |
| `getClientInvoicesFolder(clientName)` | Fallback folder lookup by exact client name match in Clients root. |
| `getNextInvoiceId()` | Generates sequential ID: `RH-INV-YY-MMDD-NN`. Uses LockService to prevent duplicates. |

### ClientService.js

| Function | Description |
|---|---|
| `createFullClient(data)` | Multi-step client creation: validate → (LockService) → create Notion client → create Drive folders → update Drive Folder ID → create contacts → optionally create project. Rolls back Notion pages on failure. |

### ProjectService.js

| Function | Description |
|---|---|
| `createProject(data)` | Creates a Notion project page linked to a client. LockService protected. |

### AgreementService.js

| Function | Description |
|---|---|
| `createAgreement(data)` | Creates a Notion agreement page. Optionally copies a legal template from Drive and links the file URL. |

### ReceiptService.js

| Function | Description |
|---|---|
| `extractReceiptData(fileId, context)` | Reads a Drive file as base64 → sends to Claude Vision with context-specific prompt → returns structured JSON. Context is `'expense'` or `'payment'`. |
| `_callClaudeVision(base64Data, mimeType, context)` | Calls the Anthropic Messages API with an image/PDF. Uses **split prompts**: expense context extracts vendor/category/line items/billable; payment context extracts payment method/reference number/invoice number/payer. Handles HEIC→JPEG conversion via Drive thumbnail API. |
| `_suggestCategory(vendor, description)` | Keyword-based category fallback (Software, Gear, Travel, Contractor, Other) when AI doesn't assign one. |
| `processReceiptStaged(base64Data, fileName, mimeType, context)` | Uploads to `_Staging/` folder → runs AI extraction → returns file info + extracted data. File stays in staging until submit. |
| `_moveReceiptToFinalFolder(fileId, clientId, folderType, isPickerSource, recordId)` | Moves (staged) or copies (picker) receipt to final folder. Renames file to match record ID (e.g., `RH-EXP-26-0320-01.pdf`). Routes: client → `{Client}/Expenses|Payments/{year}/`, no client → `01_Admin/Financials/Expenses|Payments/{year}/`. |

### ExpenseService.js

| Function | Description |
|---|---|
| `logExpense(data)` | Creates a Notion expense record linked to client/project/contractor. Auto-generates expense ID (`RH-EXP-YY-MMDD-##`) if not pre-set. Accepts `data.expenseId` to skip generation (used when ID is pre-generated for file rename). Allows zero amount when status is "Review" (iOS Shortcut flow). |
| `_generateExpenseId(dateStr)` | Sequential ID generator with LockService protection. Format: `RH-EXP-26-0320-01`. Tracks last ID in Script Properties to maintain sequence within a day. |

### PaymentService.js

| Function | Description |
|---|---|
| `logPayment(data)` | Creates a Notion payment record. Auto-generates payment ID (`RH-PAY-YY-MMDD-##`) if not pre-set. Optionally updates invoice status to "Paid" when `data.markPaid` is true. |
| `_generatePaymentId(dateStr)` | Sequential ID generator with LockService protection. Same format as expenses but with `RH-PAY` prefix. |

### GmailService.js

| Function | Description |
|---|---|
| `createDocumentDraft(data)` | Creates or sends an email via Gmail. Resolves templates, replaces `{{variables}}`, processes conditionals, attaches Drive files. |
| `createInvoiceDraft(data)` | Creates a Gmail draft for a specific invoice (used by the webapp form's "Draft Email" button). |
| `getEmailTemplates()` | Returns all email templates (4 built-in + custom). |
| `saveEmailTemplate(data)` | Creates or updates a template in PropertiesService. |
| `deleteEmailTemplate(id)` | Deletes a custom template. |
| `resetEmailTemplate(id)` | Resets a customized built-in template. |
| `_resolveTemplate(templates, type)` | Finds the active template for a given type. |
| `_applyTemplate(template, vars)` | Replaces `{{variables}}` and processes `{{#conditional}}...{{/conditional}}` blocks. |

### DriveService.js

| Function | Description |
|---|---|
| `createClientFolderStructure(clientName)` | Creates the standard subfolder hierarchy (Proposals, Assets, Invoices, Contracts, Projects, Meeting Notes, Expenses, Payments) under a new client folder. |
| `resolveSubfolder(parentFolderId, name)` | Finds a subfolder by name. Returns ID or null. |
| `resolveOrCreateSubfolder(parentFolderId, name)` | Finds or creates a subfolder. Used for year subfolders and staging. |
| `resolveClientInvoicesFolder(driveFolderId)` | Resolves the "Invoices" subfolder within a client's Drive folder. |
| `resolveExpenseFolder(clientDriveFolderId, year)` | Resolves `Client/Expenses/{year}/` or `Admin/Financials/Expenses/{year}/`. Creates subfolders on demand. |
| `resolvePaymentFolder(clientDriveFolderId, year)` | Resolves `Client/Payments/{year}/` or `Admin/Financials/Payments/{year}/`. Creates subfolders on demand. |
| `uploadFileToDrive(base64Data, fileName, mimeType, targetFolderId)` | Decodes base64 → creates a Blob → saves to the specified Drive folder. Returns `{ fileId, fileUrl, fileName }`. |
| `getFileAsBase64(fileId)` | Reads a Drive file and returns base64-encoded content. Used to send receipts to the AI extraction API. Handles HEIC files via Drive thumbnail conversion. |
| `moveDriveFile(fileId, targetFolderId)` | Moves a file to a new folder. Used when editing expenses/payments and changing the client. |
| `trashDriveFile(fileId)` | Moves a file to Drive trash (recoverable). Used when deleting expenses/payments. |
| `extractDriveFileId(url)` | Extracts the file ID from various Google Drive URL formats (`/d/ID/`, `?id=ID`, etc.). |
| `cleanupStagingFolder(maxAgeHours)` | Deletes files in `_Staging/` older than the specified hours. Default: 24 hours. Called by daily trigger. |

### Utils.js

| Function | Description |
|---|---|
| `_addDays(isoDate, days)` | DST-safe date addition. Returns ISO date string. |
| `_formatDateForDoc(iso)` | Converts `2026-03-15` → `March 15, 2026`. |
| `formatCurrency(n)` | Formats number as `1,234.56` (no dollar sign). Used in invoice template. |
| `escapeRegex(str)` | Escapes regex special characters for `replaceText()`. |

---

## Invoice Form (sidebar.html + webapp.html + form-shared.html)

The invoice generator form exists in two identical HTML shells (`sidebar.html` for the Apps Script sidebar, `webapp.html` for the standalone web app). Both include `form-shared.html` for shared JavaScript.

| Function | Description |
|---|---|
| `window.onload` | Sets today's date, calculates due date (+14 days), loads clients. |
| `loadClients()` | Fetches all clients and populates the dropdown. Then calls `loadProjects()`. |
| `loadProjects()` | Fetches all projects. Shows the form after loading. |
| `onClientChange()` | Auto-fills billing fields when a client is selected. Filters project dropdown. |
| `filterProjects()` | Filters project dropdown to show only projects for the selected client. |
| `updateDueDate()` | Sets due date to issue date + 14 days. |
| `addLineItem()` | Adds a new line item card (name, description, qty, price). |
| `removeLineItem(n)` | Removes a line item and recalculates totals. |
| `getLineItems()` | Collects all line items into an array. |
| `updateTotals()` | Recalculates and displays subtotal, tax, total. |
| `generate()` | Validates the form, builds the data object, calls `generateInvoice()` server-side. |
| `draftEmail()` | Creates a Gmail draft with the last generated invoice attached. |
| `resetForm()` | Clears all fields for generating another invoice. |

---

## Configuration (Config.js)

All configuration is centralized in the `CONFIG` object:

| Key | Source | Description |
|---|---|---|
| `NOTION_TOKEN` | Script Properties | Notion integration API token (secret). |
| `API_SECRET` | Script Properties | Webhook API secret (secret). |
| `ANTHROPIC_API_KEY` | Script Properties | Anthropic API key for Claude Vision receipt extraction (secret). |
| `TEMPLATE_ID` | Inline | Google Doc invoice template ID. |
| `NOTION_*_DB` (8 keys) | Inline | Notion database IDs for each entity type (Clients, Contacts, Projects, Agreements, Invoices, Expenses, Payments, Contractors). |
| `CLIENTS_DRIVE_ROOT` | Inline | Drive folder ID: `03_Clients/` |
| `ASSETS_DRIVE_ROOT` | Inline | Drive folder ID: `02_Assets/` |
| `FINANCIALS_DRIVE_DIR` | Inline | Drive folder ID: `01_Admin/Financials/` — fallback folder for non-client expenses and payments. |
| `LEGAL_CONTRACTS_DIR` | Inline | Drive folder ID: `02_Assets/Legal/Contracts/` |
| `LEGAL_INVOICES_DIR` | Inline | Drive folder ID: `02_Assets/Legal/Invoices/` |
| `CLIENT_SUBFOLDERS` | Inline | Standard subfolder names created for each client. |
| `COMPANY_*` (4 keys) | Inline | Company name, email, address, phone. |

---

## Status Flows

### Invoice Lifecycle
```
Draft → Sent → Paid
              ↘ Overdue → Paid
                         ↘ Void (at any point)
```
- **Draft → Sent**: Manual (status dropdown)
- **Sent → Overdue**: Automatic (`checkOverdueInvoices()` trigger)
- **Sent/Overdue → Paid**: Manual or via "Log Payment" with auto-mark
- **Any → Void**: Manual

### Project Lifecycle
```
Draft → Active → Paused → Active (toggle)
                        ↘ Closed
                           ↘ Archived (separate action)
```

### Agreement Lifecycle
```
Draft → Sent → Signed
              ↘ Void (at any point)
```

### Expense Lifecycle
```
Review → Logged
```
- **Review**: Set automatically by iOS Shortcut (not reviewed on device). User edits on dashboard to confirm.
- **Logged**: Set when logged from the dashboard (user reviewed before submitting).

### Payment Lifecycle
```
Review → Logged
```
- Same pattern as expenses. Review = shortcut, Logged = dashboard.

### Client Lifecycle
```
Active → Archived (via Archive button)
```
