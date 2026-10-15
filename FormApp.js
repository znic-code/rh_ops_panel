// ── HTML INCLUDE HELPER ────────────────────────────────────────
// Standard Apps Script pattern for including partial HTML files.
// Used by sidebar.html and webapp.html via <?!= include('form-shared') ?>

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// ── LEGACY INVOICE FORM RPCs ───────────────────────────────────
// form-shared.html (sidebar.html, webapp.html / ?page=invoice) calls these
// by name via google.script.run, so they stay public. Server code calls the
// private versions directly.

function getClients()          { return getClients_(); }
function getProjects()         { return getProjects_(); }
function generateInvoice(data) { return generateInvoice_(data); }
