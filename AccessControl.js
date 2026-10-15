// ── ACCESS CONTROL ────────────────────────────────────────────
// Role-based access for the Road Hazards Ops Panel.
//
// Roles:
//   'admin'   — full access (create, edit, delete, settings, backup)
//   'partner' — full operational access; no settings, no deletes
//   'staff'   — read-only clients, projects, contacts; no financials
//               (no invoices, quotes, agreements, expenses, payments,
//               contractors, dashboard or reports)
//
// The bootstrap admin email is always 'admin' regardless of the role table,
// so the owner can never be locked out.
//
// WHAT IS CALLABLE FROM THE BROWSER:
//   google.script.run can call any top-level function whose name does NOT
//   end in "_" (a leading underscore does not hide it). So:
//     - every helper ends in "_" (private);
//     - every public function is an entry point and checks access itself:
//       panel* RPCs and the legacy invoice-form RPCs call _requireRole_();
//       trigger handlers call _requireTriggerOrRole_();
//       panelGetCurrentUser, doGet, doPost, onOpen and include are the only
//       ungated ones (doPost and doGet ?page=api check API_SECRET).
//   A new server function must either end in "_" or start with a gate.
//
// DEPLOYMENT NOTE:
//   Deploy the web app as Execute as: "User accessing the web app"
//   (USER_ACCESSING) and Who has access: "Anyone within roadhazardsmedia.com"
//   (DOMAIN), matching appsscript.json. In that setup
//   Session.getActiveUser().getEmail() reliably identifies the caller.
//   Never deploy this project as Execute as: "Me" (USER_DEPLOYING): every
//   call would then use the owner's Drive/Gmail, and anonymous or outside
//   visitors have a blank email. _getCallerEmail_ gives them no role; it used
//   to fall back to the owner, which made every such visitor admin. An
//   endpoint for the iOS Shortcut belongs in a separate API-only project, not
//   in an owner-mode deployment of this one.
// ─────────────────────────────────────────────────────────────

var _BOOTSTRAP_ADMIN = 'hello@roadhazardsmedia.com';

/**
 * Returns the email of the user currently calling the server function,
 * or '' if it is unknown. Requires executeAs: USER_ACCESSING.
 * Fails closed: there is deliberately no fallback to
 * Session.getEffectiveUser(), which is the owner (bootstrap admin) under an
 * "Execute as: Me" deployment. An unknown caller gets no role.
 */
function _getCallerEmail_() {
  try {
    return Session.getActiveUser().getEmail() || '';
  } catch (e) { return ''; }
}

/**
 * Returns the calling user's role string, or null if not authorized.
 * Bootstrap admin always returns 'admin'.
 */
function _getCallerRole_() {
  var email = _getCallerEmail_();
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
function _requireRole_(allowed) {
  var role = _getCallerRole_();
  if (!role || allowed.indexOf(role) === -1) {
    throw new Error('Access denied.');
  }
}

/**
 * Gate for time-driven trigger handlers. They stay public so their triggers
 * keep working, and a trigger run has no user session, so it skips
 * _requireRole_(): Apps Script passes an event whose triggerUid matches one
 * of the effective user's triggers on this project. Anything else
 * (google.script.run, the editor's Run button) must come from an allowed role.
 * A browser caller can't fake this: getProjectTriggers() only returns the
 * caller's own triggers, and outside users have none.
 * @param {*} e               the handler's first argument (event object on trigger runs)
 * @param {string[]} allowed  roles allowed to run the handler manually
 */
function _requireTriggerOrRole_(e, allowed) {
  var uid = e && e.triggerUid ? String(e.triggerUid) : '';
  if (uid) {
    var isOwnTrigger = ScriptApp.getProjectTriggers().some(function(t) {
      return t.getUniqueId() === uid;
    });
    if (isOwnTrigger) return;
  }
  _requireRole_(allowed);
}

/**
 * Returns { email, role } for the frontend to store at load time.
 * role is null if the caller is not in the role table.
 */
function panelGetCurrentUser() {
  var email = _getCallerEmail_();
  var role  = _getCallerRole_();
  return { email: email, role: role };
}

/**
 * Returns the role table as { email: role } pairs.
 * Admin only.
 */
function panelGetRoleTable() {
  _requireRole_(['admin']);
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
  _requireRole_(['admin']);
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
