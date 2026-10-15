// ── HTML INCLUDE HELPER ────────────────────────────────────────
// Standard Apps Script pattern for including partial HTML files.
// Used by sidebar.html and webapp.html via <?!= include('form-shared') ?>

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// ── LEGACY INVOICE FORM RPCs ───────────────────────────────────
// form-shared.html (sidebar.html, webapp.html / ?page=invoice) calls these
// by name via google.script.run, so they stay public and are gated like the
// panel's invoice RPCs. Server code calls the private versions directly.

function getClients() {
  _requireRole_(['admin', 'partner']);
  return getClients_();
}

function getProjects() {
  _requireRole_(['admin', 'partner']);
  return getProjects_();
}

function generateInvoice(data) {
  _requireRole_(['admin', 'partner']);
  return generateInvoice_(data);
}
