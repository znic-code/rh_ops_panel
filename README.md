# RH Ops Panel

Internal operations panel for **Road Hazards Media** — a Google Apps Script web application that manages clients, projects, invoices, expenses, payments, agreements, and contractors, with Notion as the database and Google Drive/Gmail for file and email workflows.

---

## What It Does

- **Clients & Contacts** — full client records with billing info, contacts, Drive folder structure auto-created on client creation
- **Projects** — linked to clients, supports retainer/recurring billing configuration
- **Invoices** — generate from a Google Doc template, export as PDF, save to Drive, log to Notion; inline payment logging with withholding support
- **Quotes** — same generation pipeline as invoices with convert-to-invoice flow
- **Expenses** — log with receipt upload and AI extraction (Claude Vision); linked to clients, projects, or contractors
- **Payments** — log with receipt upload and AI extraction; auto-links to invoices and handles withholding math
- **Agreements** — track contracts with status lifecycle (Draft → Sent → Signed)
- **Contractors** — track vendors and partners with W-9 storage
- **Reports** — revenue, profit, and expense charts; export to Google Sheets
- **Email** — templated Gmail drafts/sends for invoices and agreements
- **iOS Shortcut** — quick-log expenses and payments from iPhone; AI extracts receipt data and queues for review
- **Settings** — invoice reminders, email templates, backup to Sheets, system health check

---

## Architecture

```
panel.html  (Single-page frontend — stack-based navigation)
    ↓  google.script.run
Main.js  (Orchestration — panel* functions, caching, triggers)
    ↓
Service Files  (Business logic per domain)
    ↓
NotionService.js  (All Notion API calls — retry logic, pagination, batch requests)
```

External integrations: **Notion API**, **Google Drive**, **Gmail**, **Google Sheets**, **Anthropic Claude Vision** (receipt extraction), **Google Picker API**.

---

## File Structure

```
Config.js               — CONFIG object + NP (Notion property name constants)
Main.js                 — All panel* functions, API router, triggers, caching
NotionService.js        — Notion data access layer (queries, mappers, writes)
ClientService.js        — Multi-step client creation with Drive folder setup
ProjectService.js       — Project creation
InvoiceService.js       — Invoice generation pipeline (Doc → PDF → Drive → Notion)
QuoteService.js         — Quote generation pipeline
AgreementService.js     — Agreement creation
ExpenseService.js       — Expense logging with ID generation
PaymentService.js       — Payment logging with ID generation
ReceiptService.js       — AI receipt extraction + staged file upload/move
DriveService.js         — Drive folder resolution, file moves, staging cleanup
GmailService.js         — Email drafts, templates, conditional variable replacement
AccessControl.js        — API authentication
Utils.js                — Shared date/format helpers
FormApp.js              — Invoice generator form entry point
panel.html              — Main SPA frontend
sidebar.html            — Invoice generator (sidebar shell)
webapp.html             — Invoice generator (standalone web app shell)
form-shared.html        — Shared JS for invoice generator forms
appsscript.json         — GAS manifest
TECHNICAL_REFERENCE.md  — Full function-level documentation
```

---

## Setup

### Prerequisites

- [clasp](https://github.com/google/clasp) installed (`npm install -g @google/clasp`)
- A Google account with Apps Script enabled
- A Notion integration token
- An Anthropic API key (for receipt AI extraction)

### 1. Clone and link

```bash
git clone https://github.com/znic-code/rh_ops_panel.git
cd rh_ops_panel
```

Create `.clasp.json` (not committed — contains your script ID):

```json
{
  "scriptId": "YOUR_SCRIPT_ID",
  "rootDir": "/path/to/rh_ops_panel"
}
```

### 2. Push to Apps Script

```bash
clasp push --force
```

### 3. Set Script Properties

In the Apps Script editor → **Project Settings → Script Properties**, add:

| Key | Value |
|---|---|
| `NOTION_TOKEN` | Your Notion integration token |
| `API_SECRET` | A random secret for the iOS Shortcut API |
| `ANTHROPIC_API_KEY` | Your Anthropic API key |

### 4. Update Config.js

Set the correct Notion database IDs and Google Drive folder IDs in `Config.js` for your workspace.

### 5. Deploy

In the Apps Script editor, create a **Web App** deployment. The panel is served via `doGet()`.

### 6. Set up triggers

In the Apps Script editor → **Triggers**, add daily time-driven triggers for:

- `checkOverdueInvoices`
- `sendInvoiceReminders`
- `generateRecurringInvoices`
- `dailyHealthCheckEmail`
- `backupNotionData`
- `cleanupStagingFolder`

---

## Notion Property Constants

All Notion property names are centralized in the `NP` object in `Config.js`. Never use inline string literals for property names — always reference `NP.<DB>.<PROP>`.

```js
// Read
p[NP.PAYMENTS.AMOUNT]?.number ?? 0

// Write
var props = {};
props[NP.INVOICES.STATUS] = { select: { name: 'Paid' } };

// Filter
{ property: NP.INVOICES.STATUS, select: { equals: 'Paid' } }
```

If a Notion property is ever renamed, update the single entry in `Config.js` and it propagates everywhere.

---

## ID Formats

| Entity | Format | Example |
|---|---|---|
| Invoice | `RH-INV-YY-MMDD-NN` | `RH-INV-26-0418-01` |
| Expense | `RH-EXP-YY-MMDD-NN` | `RH-EXP-26-0418-01` |
| Payment | `RH-PAY-YY-MMDD-NN` | `RH-PAY-26-0418-01` |

All IDs are generated with `LockService` to prevent duplicates.

---

## Documentation

Full function-level reference: [`TECHNICAL_REFERENCE.md`](./TECHNICAL_REFERENCE.md)
