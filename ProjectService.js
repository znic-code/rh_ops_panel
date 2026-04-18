// ── PROJECT SERVICE ──────────────────────────────────────────
// Project creation, status updates, listing by client.

/**
 * Create a new project linked to a client.
 *
 * @param {Object} data
 * @param {string} data.name
 * @param {string} data.clientId   Notion page ID
 * @param {string} data.type       One-Off / Retainer
 * @param {string} data.startDate  ISO date
 * @param {string} [data.notes]
 * @returns {Object} { success, project, error? }
 */
function createProject(data) {
  // Validate required fields (fast-fail before acquiring lock)
  if (!data.name || !data.name.trim()) {
    return { success: false, error: 'Project name is required.' };
  }
  if (!data.clientId) {
    return { success: false, error: 'Client ID is required.' };
  }

  // Acquire script lock to prevent duplicate creation from simultaneous requests
  var lock = LockService.getScriptLock();
  try { lock.waitLock(15000); } catch (e) {
    return { success: false, error: 'Server busy \u2014 please try again in a moment.' };
  }

  try {
    const page = createNotionProject({
      name:      data.name,
      clientId:  data.clientId,
      type:      data.type || 'One-Off',
      status:    'Draft',
      startDate: data.startDate || '',
      notes:     data.notes || '',
    });
    return {
      success: true,
      project: {
        id:       page.id,
        name:     data.name,
        notionUrl: page.url || '',
      },
    };
  } catch (e) {
    return { success: false, error: e.message };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Update a project's status.
 *
 * @param {string} projectId  Notion page ID
 * @param {string} status     Draft / Active / Paused / Closed
 * @returns {Object} { success, error? }
 */
function setProjectStatus(projectId, status) {
  try {
    if (!projectId) return { success: false, error: 'Project ID is required.' };
    var validStatuses = ['Draft', 'Active', 'Paused', 'Closed'];
    if (validStatuses.indexOf(status) === -1) {
      return { success: false, error: 'Invalid status. Must be one of: ' + validStatuses.join(', ') };
    }
    updateProjectStatus(projectId, status);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

