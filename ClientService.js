// ── CLIENT SERVICE ───────────────────────────────────────────
// Orchestrates client creation: Notion records + Drive folder.

/**
 * Create a full client with contacts, project, and Drive folder.
 *
 * @param {Object} data
 * @param {string} data.name          Client name
 * @param {string} data.type          Business / Individual
 * @param {string} data.billingEmail
 * @param {string} data.billingStreet
 * @param {string} data.billingCity
 * @param {string} data.billingState
 * @param {string} data.billingZip
 * @param {string} data.billingCountry
 * @param {string} data.phone
 * @param {string} data.website
 * @param {Array}  data.contacts      [{name, email, phone, role, isPrimary}]
 * @param {string} data.projectName
 * @param {string} data.projectType   One-Off / Retainer
 * @param {string} data.startDate     ISO date
 * @param {string} [data.notes]
 * @returns {Object} { success, client, contacts, project, driveFolderId, error? }
 */
function createFullClient(data) {
  // Validate required fields (fast-fail before acquiring lock)
  if (!data.name || !data.name.trim()) {
    return { success: false, error: 'Client name is required.' };
  }

  // Acquire script lock to prevent duplicate creation from simultaneous requests
  var lock = LockService.getScriptLock();
  try { lock.waitLock(15000); } catch (e) {
    return { success: false, error: 'Server busy \u2014 please try again in a moment.' };
  }

  var createdNotionIds = []; // Track for rollback
  var driveFolderId = null;

  try {
    // 1. Create Client record in Notion
    var clientPage = createNotionClient({
      name:           data.name,
      type:           data.type,
      billingEmail:   data.billingEmail,
      billingStreet:  data.billingStreet,
      billingCity:    data.billingCity,
      billingState:   data.billingState,
      billingZip:     data.billingZip,
      billingCountry: data.billingCountry || 'US',
      phone:          data.phone,
      website:        data.website,
      notes:          data.notes,
    });
    var clientId = clientPage.id;
    createdNotionIds.push(clientId);

    // 2. Create Contact records
    var contactResults = [];
    if (data.contacts && data.contacts.length) {
      for (var i = 0; i < data.contacts.length; i++) {
        var c = data.contacts[i];
        var contactPage = createNotionContact({
          name:      c.name,
          clientId:  clientId,
          role:      c.role || '',
          email:     c.email || '',
          phone:     c.phone || '',
        });
        createdNotionIds.push(contactPage.id);
        contactResults.push({ id: contactPage.id, name: c.name });
      }
      // Set first contact as primary on the client record
      if (contactResults.length > 0) {
        _notionUpdatePage(clientId, {
          'Primary Contact': { relation: [{ id: contactResults[0].id }] }
        });
      }
    }

    // 3. Create Project record
    var projectResult = null;
    if (data.projectName) {
      var projectPage = createNotionProject({
        name:      data.projectName,
        clientId:  clientId,
        type:      data.projectType || 'One-Off',
        status:    'Draft',
        startDate: data.startDate || '',
      });
      createdNotionIds.push(projectPage.id);
      projectResult = { id: projectPage.id, name: data.projectName };
    }

    // 4. Create Drive folder structure
    driveFolderId = createClientFolderStructure(data.name);

    // 5. Write Drive Folder ID back to the Client record
    updateClientDriveFolderId(clientId, driveFolderId);

    return {
      success: true,
      client: { id: clientId, name: data.name, notionUrl: clientPage.url || '' },
      contacts: contactResults,
      project: projectResult,
      driveFolderId: driveFolderId,
    };
  } catch (e) {
    // Rollback: archive any Notion pages we created
    createdNotionIds.forEach(function(id) {
      try { archiveNotionPage(id); } catch (ce) {
        Logger.log('createFullClient cleanup failed for ' + id + ': ' + ce.message);
      }
    });
    // Attempt to trash Drive folder if it was created
    if (driveFolderId) {
      try { DriveApp.getFolderById(driveFolderId).setTrashed(true); } catch (_) {}
    }
    return { success: false, error: e.message };
  } finally {
    lock.releaseLock();
  }
}
