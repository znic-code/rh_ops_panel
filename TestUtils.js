// ── TEST UTILITIES ────────────────────────────────────────────
// Run seedTestData() from the Apps Script editor to create a
// full set of test records (client, contact, project, MSA).
// Run teardownTestData() when done to archive everything and
// trash the Drive folder.
//
// IDs are stored in Script Properties under TEST_* keys so
// teardown always knows exactly what to clean up, even across
// editor sessions.
//
// HOW TO RUN:
//   Apps Script editor → select function → ▶ Run
//   Check Execution log (View → Logs) for results.
// ─────────────────────────────────────────────────────────────

var _TEST_PROPS = {
  CLIENT_ID:    'TEST_CLIENT_ID',
  CONTACT_IDS:  'TEST_CONTACT_IDS',   // comma-separated Notion page IDs
  PROJECT_ID:   'TEST_PROJECT_ID',
  DRIVE_FOLDER: 'TEST_DRIVE_FOLDER',
  SEEDED_AT:    'TEST_SEEDED_AT',
};

// ── Seed ─────────────────────────────────────────────────────

/**
 * Create a baseline set of test records:
 *   - 1 client  ([TEST] Road Hazards — Sample Co)
 *   - 1 contact ([TEST] Sample Contact)
 *   - 1 project ([TEST] Sample Project)
 *
 * Agreements, invoices, quotes etc. are tested manually through the
 * panel UI — that's the point of the test cycle.
 *
 * IDs are written to Script Properties so teardownTestData()
 * can clean everything up without guessing.
 *
 * Safe to call from the Apps Script editor as the project owner —
 * bypasses _requireRole() wrappers intentionally.
 */
function seedTestData() {
  var sp = PropertiesService.getScriptProperties();

  // Guard: don't double-seed
  if (sp.getProperty(_TEST_PROPS.CLIENT_ID)) {
    Logger.log('[TEST] Seed data already exists. Run teardownTestData() first.');
    Logger.log('[TEST] Seeded at: ' + sp.getProperty(_TEST_PROPS.SEEDED_AT));
    return;
  }

  Logger.log('[TEST] Seeding test data...');

  // ── 1. Client + Contact + Project ────────────────────────
  var clientResult = createFullClient({
    name:           '[TEST] Road Hazards — Sample Co',
    type:           'Business',
    billingEmail:   'test@example.com',
    billingStreet:  '123 Test Street',
    billingCity:    'San Juan',
    billingState:   'PR',
    billingZip:     '00901',
    billingCountry: 'US',
    phone:          '+1 (787) 000-0000',
    notes:          'Test record — safe to delete.',
    contacts: [
      { name: '[TEST] Sample Contact', email: 'contact@example.com', role: 'Marketing Manager', phone: '+1 (787) 000-0001' },
    ],
    projectName: '[TEST] Sample Project',
    projectType: 'Retainer',
    startDate:   new Date().toISOString().split('T')[0],
  });

  if (!clientResult.success) {
    Logger.log('[TEST] ERROR creating client: ' + clientResult.error);
    return;
  }

  var clientId      = clientResult.client.id;
  var contactIds    = (clientResult.contacts || []).map(function(c) { return c.id; });
  var projectId     = clientResult.project ? clientResult.project.id : '';
  var driveFolderId = clientResult.driveFolderId;

  Logger.log('[TEST] Client created:  ' + clientId + ' (' + clientResult.client.notionUrl + ')');
  contactIds.forEach(function(cid) { Logger.log('[TEST] Contact created: ' + cid); });
  if (projectId) Logger.log('[TEST] Project created: ' + projectId);
  Logger.log('[TEST] Drive folder:   ' + driveFolderId);

  // ── 2. Persist IDs to Script Properties ──────────────────
  sp.setProperties({
    TEST_CLIENT_ID:    clientId,
    TEST_CONTACT_IDS:  contactIds.join(','),
    TEST_PROJECT_ID:   projectId,
    TEST_DRIVE_FOLDER: driveFolderId,
    TEST_SEEDED_AT:    new Date().toISOString(),
  });

  Logger.log('[TEST] Done. All IDs saved to Script Properties.');
  Logger.log('[TEST] Run teardownTestData() when finished testing.');
}

// ── Teardown ──────────────────────────────────────────────────

/**
 * Archive all Notion records created by seedTestData() and
 * move the client Drive folder to trash.
 *
 * Reads IDs from Script Properties — works correctly even if
 * called in a different editor session from seedTestData().
 */
function teardownTestData() {
  var sp  = PropertiesService.getScriptProperties();
  var clientId   = sp.getProperty(_TEST_PROPS.CLIENT_ID);
  var contactIds = sp.getProperty(_TEST_PROPS.CONTACT_IDS);
  var projectId  = sp.getProperty(_TEST_PROPS.PROJECT_ID);
  var folderId   = sp.getProperty(_TEST_PROPS.DRIVE_FOLDER);

  if (!clientId) {
    Logger.log('[TEST] Nothing to tear down — no seed data found in Script Properties.');
    return;
  }

  Logger.log('[TEST] Tearing down test data...');
  var errors = [];

  // Archive Notion records — children first, then parent client
  function archiveSafely(id, label) {
    if (!id) return;
    try {
      archiveNotionPage(id);
      Logger.log('[TEST] Archived ' + label + ': ' + id);
    } catch (e) {
      var msg = 'Failed to archive ' + label + ' (' + id + '): ' + e.message;
      Logger.log('[TEST] ERROR: ' + msg);
      errors.push(msg);
    }
  }

  if (projectId) archiveSafely(projectId, 'Project');

  if (contactIds) {
    contactIds.split(',').forEach(function(cid) {
      if (cid) archiveSafely(cid.trim(), 'Contact');
    });
  }

  archiveSafely(clientId, 'Client');

  // Trash the Drive folder (moves to Trash, not permanent delete)
  if (folderId) {
    try {
      DriveApp.getFolderById(folderId).setTrashed(true);
      Logger.log('[TEST] Drive folder moved to trash: ' + folderId);
    } catch (e) {
      var msg = 'Failed to trash Drive folder (' + folderId + '): ' + e.message;
      Logger.log('[TEST] ERROR: ' + msg);
      errors.push(msg);
    }
  }

  // Clear Script Properties regardless of errors
  sp.deleteProperty(_TEST_PROPS.CLIENT_ID);
  sp.deleteProperty(_TEST_PROPS.CONTACT_IDS);
  sp.deleteProperty(_TEST_PROPS.PROJECT_ID);
  sp.deleteProperty(_TEST_PROPS.DRIVE_FOLDER);
  sp.deleteProperty(_TEST_PROPS.SEEDED_AT);

  if (errors.length === 0) {
    Logger.log('[TEST] Teardown complete. Script Properties cleared.');
  } else {
    Logger.log('[TEST] Teardown finished with ' + errors.length + ' error(s). Some records may need manual cleanup in Notion or Drive.');
  }
}

// ── Inspect ───────────────────────────────────────────────────

/**
 * Log the current seeded test record IDs without changing anything.
 * Useful for checking what's active before running teardown.
 */
function inspectTestData() {
  var sp = PropertiesService.getScriptProperties();
  var clientId    = sp.getProperty(_TEST_PROPS.CLIENT_ID);

  if (!clientId) {
    Logger.log('[TEST] No seed data active.');
    return;
  }

  Logger.log('[TEST] Active seed data:');
  Logger.log('  Client ID:    ' + clientId);
  Logger.log('  Contact IDs:  ' + (sp.getProperty(_TEST_PROPS.CONTACT_IDS) || '(none)'));
  Logger.log('  Project ID:   ' + (sp.getProperty(_TEST_PROPS.PROJECT_ID)  || '(none)'));
  Logger.log('  Drive Folder: ' + (sp.getProperty(_TEST_PROPS.DRIVE_FOLDER)|| '(none)'));
  Logger.log('  Seeded at:    ' + (sp.getProperty(_TEST_PROPS.SEEDED_AT)   || '(unknown)'));
}
