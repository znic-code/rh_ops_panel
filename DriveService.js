// ── DRIVE SERVICE ────────────────────────────────────────────
// Google Drive folder creation, ID resolution, and file uploads.

/**
 * Create the standard client folder structure inside 03_Clients/.
 * Returns the root client folder ID.
 *
 * Structure:
 *   03_Clients/
 *     [Client Name]/
 *       Proposals/
 *       Assets/
 *       Invoices/
 *       Contracts/
 *       Projects/
 *       Meeting Notes/
 *       Expenses/
 *       Payments/
 */
function createClientFolderStructure(clientName) {
  const root = DriveApp.getFolderById(CONFIG.CLIENTS_DRIVE_ROOT);
  const clientFolder = root.createFolder(clientName);
  CONFIG.CLIENT_SUBFOLDERS.forEach(function(name) {
    clientFolder.createFolder(name);
  });
  return clientFolder.getId();
}

/**
 * Find a subfolder by name inside a parent folder.
 * Returns the folder ID, or null if not found.
 */
function resolveSubfolder(parentFolderId, subfolderName) {
  try {
    const parent = DriveApp.getFolderById(parentFolderId);
    const subs = parent.getFoldersByName(subfolderName);
    return subs.hasNext() ? subs.next().getId() : null;
  } catch (e) {
    return null;
  }
}

/**
 * Find a subfolder by name inside a parent folder, creating it if it doesn't exist.
 * Returns the folder ID, or null on error.
 * @param {string} parentFolderId  Drive folder ID of the parent
 * @param {string} subfolderName   Name of the subfolder to find or create
 * @returns {string|null}
 */
function resolveOrCreateSubfolder(parentFolderId, subfolderName) {
  try {
    var parent = DriveApp.getFolderById(parentFolderId);
    var subs = parent.getFoldersByName(subfolderName);
    if (subs.hasNext()) return subs.next().getId();
    return parent.createFolder(subfolderName).getId();
  } catch (e) {
    Logger.log('resolveOrCreateSubfolder error: ' + e.message);
    return null;
  }
}

/**
 * Resolve the client's Invoices folder from their Drive Folder ID.
 * Falls back to the client folder itself if Invoices/ doesn't exist.
 */
function resolveClientInvoicesFolder(clientDriveFolderId) {
  if (!clientDriveFolderId) return null;
  return resolveSubfolder(clientDriveFolderId, 'Invoices') || clientDriveFolderId;
}

/**
 * Resolve (or create) the client's Quotes folder from their Drive Folder ID.
 * Creates Quotes/ subfolder on demand if it doesn't exist.
 */
function resolveClientQuotesFolder(clientDriveFolderId) {
  if (!clientDriveFolderId) return null;
  return resolveOrCreateSubfolder(clientDriveFolderId, 'Quotes') || clientDriveFolderId;
}

// ── Expense / Payment Folder Resolution ─────────────────────

/**
 * Resolve the target folder for an expense receipt file.
 *   - Client linked:  03_Clients/{Client}/Expenses/{year}/
 *   - No client:      01_Admin/Financials/Expenses/{year}/
 * Creates subfolders on demand via resolveOrCreateSubfolder().
 *
 * @param {string|null} clientDriveFolderId  Client's Drive folder ID (null for overhead)
 * @param {string} [year]                    Year subfolder name (defaults to current year)
 * @returns {string|null} Drive folder ID for the receipt
 */
function resolveExpenseFolder(clientDriveFolderId, year) {
  var yr = year || new Date().getFullYear().toString();
  var parentId;
  if (clientDriveFolderId) {
    // Client-linked: 03_Clients/{Client}/Expenses/{year}/
    parentId = resolveOrCreateSubfolder(clientDriveFolderId, 'Expenses');
  } else {
    // Overhead: 01_Admin/Financials/Expenses/{year}/
    parentId = resolveOrCreateSubfolder(CONFIG.FINANCIALS_DRIVE_DIR, 'Expenses');
  }
  if (!parentId) return null;
  return resolveOrCreateSubfolder(parentId, yr);
}

/**
 * Resolve the target folder for a payment record file.
 *   - Client linked:  03_Clients/{Client}/Payments/{year}/
 *   - No client:      01_Admin/Financials/Payments/{year}/
 *
 * @param {string|null} clientDriveFolderId  Client's Drive folder ID (null for overhead)
 * @param {string} [year]                    Year subfolder name (defaults to current year)
 * @returns {string|null} Drive folder ID for the payment record
 */
function resolvePaymentFolder(clientDriveFolderId, year) {
  var yr = year || new Date().getFullYear().toString();
  var parentId;
  if (clientDriveFolderId) {
    parentId = resolveOrCreateSubfolder(clientDriveFolderId, 'Payments');
  } else {
    parentId = resolveOrCreateSubfolder(CONFIG.FINANCIALS_DRIVE_DIR, 'Payments');
  }
  if (!parentId) return null;
  return resolveOrCreateSubfolder(parentId, yr);
}

// ── File Upload ─────────────────────────────────────────────

/**
 * Upload a file (receipt image/PDF) to a specific Drive folder.
 * Accepts base64-encoded file data from the frontend.
 *
 * @param {string} base64Data      Base64-encoded file content
 * @param {string} fileName        Original file name (e.g., "receipt.jpg")
 * @param {string} mimeType        MIME type (e.g., "image/jpeg", "application/pdf")
 * @param {string} targetFolderId  Drive folder ID to save into
 * @returns {{ fileId: string, fileUrl: string, fileName: string }}
 */
function uploadFileToDrive(base64Data, fileName, mimeType, targetFolderId) {
  var decoded = Utilities.base64Decode(base64Data);
  var blob = Utilities.newBlob(decoded, mimeType, fileName);
  var folder = DriveApp.getFolderById(targetFolderId);
  var file = folder.createFile(blob);
  return {
    fileId:   file.getId(),
    fileUrl:  file.getUrl(),
    fileName: file.getName(),
  };
}

/**
 * Read a file from Drive and return its base64-encoded content.
 * Used to send receipt images to the AI extraction API.
 *
 * @param {string} fileId  Drive file ID
 * @returns {{ base64: string, mimeType: string, fileName: string }}
 */
/**
 * Move a Drive file to trash. Recoverable for 30 days.
 *
 * @param {string} fileId  Drive file ID
 * @returns {boolean} true if trashed
 */
/**
 * Move a Drive file to a different folder.
 * Removes from all current parents and adds to the new folder.
 *
 * @param {string} fileId          The Drive file ID to move
 * @param {string} targetFolderId  Destination folder ID
 * @returns {{ success: boolean, newUrl: string }}
 */
function moveDriveFile(fileId, targetFolderId) {
  try {
    var file = DriveApp.getFileById(fileId);
    var targetFolder = DriveApp.getFolderById(targetFolderId);

    // Remove from current parent(s)
    var parents = file.getParents();
    while (parents.hasNext()) {
      parents.next().removeFile(file);
    }

    // Add to new folder
    targetFolder.addFile(file);
    Logger.log('moveDriveFile: moved ' + fileId + ' to folder ' + targetFolderId);
    return { success: true, newUrl: file.getUrl() };
  } catch (e) {
    Logger.log('moveDriveFile: failed — ' + e.message);
    return { success: false, newUrl: '' };
  }
}

function trashDriveFile(fileId) {
  try {
    var file = DriveApp.getFileById(fileId);
    file.setTrashed(true);
    Logger.log('trashDriveFile: trashed ' + fileId + ' (' + file.getName() + ')');
    return true;
  } catch (e) {
    Logger.log('trashDriveFile: could not trash ' + fileId + ' — ' + e.message);
    return false;
  }
}

/**
 * Extract a Drive file ID from a Google Drive URL.
 * Supports /file/d/{id}/ and ?id={id} patterns.
 *
 * @param {string} url  Drive URL
 * @returns {string|null} file ID or null
 */
function extractDriveFileId(url) {
  if (!url) return null;
  // Pattern: /file/d/{fileId}/
  var match = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  // Pattern: ?id={fileId} or &id={fileId}
  match = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  // Pattern: open?id={fileId}
  match = url.match(/open\?id=([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  return null;
}

function getFileAsBase64(fileId) {
  var file = DriveApp.getFileById(fileId);
  var blob = file.getBlob();
  return {
    base64:   Utilities.base64Encode(blob.getBytes()),
    mimeType: blob.getContentType(),
    fileName: file.getName(),
  };
}

/**
 * Delete files in the _Staging folder older than a given number of hours.
 * Intended to be called by a daily time-based trigger.
 *
 * @param {number} [maxAgeHours=24]  Files older than this are deleted.
 * @returns {{ deleted: number, errors: number }}
 */
function cleanupStagingFolder(maxAgeHours) {
  var hours = maxAgeHours || 24;
  var cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
  var deleted = 0;
  var errors = 0;

  try {
    var stagingId = resolveSubfolder(CONFIG.FINANCIALS_DRIVE_DIR, '_Staging');
    if (!stagingId) {
      Logger.log('cleanupStagingFolder: _Staging folder not found — nothing to clean.');
      return { deleted: 0, errors: 0 };
    }

    var folder = DriveApp.getFolderById(stagingId);
    var files = folder.getFiles();

    while (files.hasNext()) {
      var file = files.next();
      try {
        if (file.getDateCreated() < cutoff) {
          var name = file.getName();
          file.setTrashed(true);
          Logger.log('cleanupStagingFolder: trashed "' + name + '" (created ' + file.getDateCreated().toISOString() + ')');
          deleted++;
        }
      } catch (e) {
        Logger.log('cleanupStagingFolder: error trashing file — ' + e.message);
        errors++;
      }
    }
  } catch (e) {
    Logger.log('cleanupStagingFolder error: ' + e.message);
    errors++;
  }

  Logger.log('cleanupStagingFolder: done — ' + deleted + ' deleted, ' + errors + ' errors.');
  return { deleted: deleted, errors: errors };
}
