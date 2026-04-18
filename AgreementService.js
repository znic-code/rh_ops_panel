// ── AGREEMENT SERVICE ────────────────────────────────────────
// Agreement creation and listing.

/**
 * Create a new agreement linked to a client and project.
 *
 * @param {Object} data
 * @param {string} data.title
 * @param {string} data.docType       MSA / SOW / PSA / Change Order
 * @param {string} data.clientId      Notion page ID
 * @param {string} data.projectId     Notion page ID
 * @param {string} data.effectiveDate ISO date
 * @param {string} [data.fileUrl]     Google Drive link
 * @param {string} [data.notes]
 * @returns {Object} { success, agreement, error? }
 */
function createAgreement(data) {
  try {
    // Validate required fields
    if (!data.title || !data.title.trim()) {
      return { success: false, error: 'Agreement title is required.' };
    }
    if (!data.docType) {
      return { success: false, error: 'Document type is required.' };
    }
    var validDocTypes = ['MSA', 'SOW', 'PSA', 'Change Order'];
    if (validDocTypes.indexOf(data.docType) === -1) {
      return { success: false, error: 'Invalid doc type. Must be one of: ' + validDocTypes.join(', ') };
    }

    const page = createNotionAgreement({
      title:         data.title,
      docType:       data.docType,
      status:        'Draft',
      clientId:      data.clientId,
      projectId:     data.projectId,
      effectiveDate: data.effectiveDate || '',
      fileUrl:       data.fileUrl || '',
      notes:         data.notes || '',
    });
    return {
      success: true,
      agreement: {
        id:        page.id,
        title:     data.title,
        notionUrl: page.url || '',
      },
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

