// ── HTML INCLUDE HELPER ────────────────────────────────────────
// Standard Apps Script pattern for including partial HTML files.
// Used by sidebar.html and webapp.html via <?!= include('form-shared') ?>

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}
