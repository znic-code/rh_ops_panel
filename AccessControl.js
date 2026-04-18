// ── ACCESS CONTROL ────────────────────────────────────────────
// Role-based access for the Road Hazards Ops Panel.
//
// Roles:
//   'admin'   — full access (create, edit, delete, settings, backup)
//   'partner' — full operational access; no settings, no deletes
//   'staff'   — clients, projects, contacts, agreements only; no financials
//
// The bootstrap admin email is always 'admin' regardless of the role table,
// so the owner can never be locked out.
//
// DEPLOYMENT NOTE:
//   Session.getActiveUser().getEmail() returns the accessing user's email
//   only when the web app is deployed with executeAs: "USER_ACCESSING".
//   After pushing this code, update the deployment in the GAS editor:
//     Deploy → Manage Deployments → Edit → Execute as: "Me (USER_ACCESSING)"
//   While the app runs as USER_DEPLOYING, all callers resolve to the owner
//   (admin), so existing behavior is unchanged until you redeploy.
// ─────────────────────────────────────────────────────────────

var _BOOTSTRAP_ADMIN = 'hello@roadhazardsmedia.com';

/**
 * Returns the email of the user currently calling the server function.
 * Requires executeAs: USER_ACCESSING in the deployment.
 */
function _getCallerEmail() {
  try {
    var email = Session.getActiveUser().getEmail();
    if (email) return email;
    // Fallback: when executeAs=USER_DEPLOYING, getEffectiveUser() returns the owner
    return Session.getEffectiveUser().getEmail() || '';
  } catch (e) { return ''; }
}

/**
 * Returns the calling user's role string, or null if not authorized.
 * Bootstrap admin always returns 'admin'.
 */
function _getCallerRole() {
  var email = _getCallerEmail();
  if (!email) return null;
  if (email === _BOOTSTRAP_ADMIN) return 'admin';
  try {
    var raw = PropertiesService.getScriptProperties().getProperty('user_roles');
    var roles = raw ? JSON.parse(raw) : {};
    return roles[email] || null;
  } catch (e) {
    Logger.log('_getCallerRole error: ' + e.message);
    return null;
  }
}

/**
 * Throws 'Access denied.' if the caller's role is not in the allowed list.
 * @param {string[]} allowed  e.g. ['admin'] or ['admin', 'partner']
 */
function _requireRole(allowed) {
  var role = _getCallerRole();
  if (!role || allowed.indexOf(role) === -1) {
    throw new Error('Access denied.');
  }
}

/**
 * Returns { email, role } for the frontend to store at load time.
 * role is null if the caller is not in the role table.
 */
function panelGetCurrentUser() {
  var email = _getCallerEmail();
  var role  = _getCallerRole();
  return { email: email, role: role };
}

/**
 * Returns the role table as { email: role } pairs.
 * Admin only.
 */
function panelGetRoleTable() {
  _requireRole(['admin']);
  try {
    var raw = PropertiesService.getScriptProperties().getProperty('user_roles');
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}

/**
 * Saves the role table. Admin only.
 * The bootstrap admin email cannot be added via this function — they are
 * always admin by hardcode and do not appear in the editable table.
 *
 * @param {Object} roles  { email: role } pairs to persist
 * @returns {{ success: boolean, error?: string }}
 */
function panelSaveRoleTable(roles) {
  _requireRole(['admin']);
  if (!roles || typeof roles !== 'object') {
    return { success: false, error: 'Invalid roles object.' };
  }
  var validRoles = ['admin', 'partner', 'staff'];
  var cleaned = {};
  Object.keys(roles).forEach(function(email) {
    var e = email.toLowerCase().trim();
    var r = roles[email];
    if (e && e !== _BOOTSTRAP_ADMIN && validRoles.indexOf(r) !== -1) {
      cleaned[e] = r;
    }
  });
  PropertiesService.getScriptProperties().setProperty('user_roles', JSON.stringify(cleaned));
  return { success: true };
}
