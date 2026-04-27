// Web system ui, handles authentication
// this is system-level UI, not app-specific
// doesnt load p2p-news-app.

// show authentication UI
const container = document.createElement('div')
container.className = 'system-ui'
container.innerHTML = `
    <div class="login">
      <h3>System Authentication</h3>
      <div class="make-form" style="display: none; margin-top: 10px;">
        <button class="back-btn" style="margin-bottom: 5px;">← Back</button><br>
        <input class="username-input" placeholder="Your Name">
        <button class="make-network-btn">Create Account</button>
      </div>
      <div class="join-form" style="display: none; margin-top: 10px;">
        <button class="back-btn" style="margin-bottom: 5px;">← Back</button><br>
        <input class="invite-code-input" placeholder="Paste invite code here" style="width: 300px; margin-bottom: 5px;">
        <br>
        <button class="join-with-invite-btn">Pair Device</button>
      </div>
      <div class="load-form" style="display: none; margin-top: 10px;">
        <button class="back-btn" style="margin-bottom: 5px;">← Back</button><br>
        <input class="mnemonic-input" placeholder="Enter mnemonic phrase" style="width: 300px;">
        <button class="load-mnemonic-btn">Load from Mnemonic</button>
      </div>
      <div class="apps-form" style="display: none; margin-top: 10px;">
        <h4>Apps found in vault:</h4>
        <div class="apps-list"></div>
        <div class="apps-status" style="margin-top: 10px; color: #666;"></div>
      </div>
      <div class="initial-buttons">
        <button class="make-btn">Seed</button>
        <button class="join-btn">Pair</button>
        <button class="load-btn">Load</button>
        <button class="reset-all-btn">Reset All Data</button>
      </div>
      <div class="status" style="margin-top: 10px; color: #666;"></div>
    </div>
  `
document.body.appendChild(container)

/***************************************
SEED MODE HANDLER
***************************************/
async function handle_seed () {
  const username = container.querySelector('.username-input').value.trim()
  if (!username) return alert('Please enter your name.')
  try {
    container.querySelector('.status').textContent = 'Creating account...'
    vault.session_set_username(username)
    vault.session_set_auth_mode('seed')
    vault.session_set_joined_app('p2p-news-app')
    // Show system bar
    show_system_bar()
    // Authenticate via vault
    await vault.authenticate({
      username: username,
      mode: 'seed'
    })
  } catch (err) {
    container.querySelector('.status').textContent = 'Error: ' + err.message
  }
}

/***************************************
PAIR MODE HANDLER
***************************************/
async function handle_pair () {
  const invite_code = container.querySelector('.invite-code-input').value.trim()
  if (!invite_code) return alert('Please enter an invite code.')
  // Validate invite code
  try {
    const decoded = Buffer.from(invite_code, 'base64')
    if (decoded.length < 32) {
      return alert('Invite code is too short. Make sure you copied the entire code.')
    }
  } catch (err) {
    return alert('Invalid invite code format. Make sure you copied it correctly.')
  }
  try {
    container.querySelector('.status').innerHTML = 'Pairing... <button class="cancel-pair-btn" style="margin-left:8px">Cancel</button>'
    container.querySelector('.cancel-pair-btn').addEventListener('click', handle_cancel_pair)
    // Store invite code for app to use
    vault.session_set_pending_invite(invite_code)
    vault.session_set_auth_mode('pair')
    // For now, use placeholder username
    const username = 'pairing-user'
    vault.session_set_username(username)
    let overlay = null
    // Listen for vault_ready event (fires when vault is paired but before user resolves)
    vault.on_vault_ready(handle_vault_ready)
    async function handle_vault_ready (auth_data) {
      console.log('[websys-ui] Vault ready, starting app discovery')
      // Remove overlay
      if (overlay) {
        document.body.removeChild(overlay)
        overlay = null
      }
      // Update username from pairing result
      if (auth_data.username && auth_data.username !== 'pairing-user') {
        vault.session_set_username(auth_data.username)
      }
      // Now show apps discovery UI
      container.querySelector('.status').textContent = 'Vault paired! Discovering apps...'
      container.querySelector('.join-form').style.display = 'none'
      container.querySelector('.apps-form').style.display = 'block'
      // Discover and show apps from vault
      await discover_and_show_apps()
    }
    vault.authenticate({
      username: username,
      mode: 'pair',
      invite_code: invite_code,
      on_verification_code: handle_verification_code
    })
    function handle_verification_code (verification_code) {
      overlay = document.createElement('div')
      overlay.style.cssText = 'position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: white; display: flex; align-items: center; justify-content: center;'
      overlay.innerHTML = `
          <div style="text-align: center;">
            <p>Verification Code:</p>
            <h1>${verification_code}</h1>
            <p>Waiting for Inviting device to verify...</p>
            <button class="cancel-pair-btn" style="margin-top:10px">Cancel Pairing</button>
          </div>
      `
      overlay.querySelector('.cancel-pair-btn').addEventListener('click', handle_cancel_pair)
      document.body.appendChild(overlay)
    }
    vault.user.catch(handle_pairing_error)
    function handle_pairing_error (err) {
      if (overlay) document.body.removeChild(overlay)
      alert('Pairing failed: ' + err.message)
      vault.session_clear()
      location.reload()
    }
    function handle_cancel_pair () {
      if (overlay) { document.body.removeChild(overlay); overlay = null }
      vault.cancel_vault_invite()
      vault.session_clear()
      location.reload()
    }
  } catch (err) {
    container.querySelector('.status').textContent = 'Error: ' + err.message
  }
}

/***************************************
DISCOVER AND SHOW APPS
***************************************/
async function discover_and_show_apps () {
  const apps_list = container.querySelector('.apps-list')
  const apps_status = container.querySelector('.apps-status')
  const vault_bee = vault.get_vault_bee()
  apps_status.textContent = 'Syncing vault...'
  await vault_bee.update()
  let apps = await vault.list_apps()
  if (!apps || apps.length === 0) {
    apps_status.textContent = 'Waiting for vault to sync...'
    for await (const _ of vault_bee.watch({ gte: 'apps/', lt: 'apps0' })) {
      apps = await vault.list_apps()
      if (apps && apps.length > 0) break
    }
  }
  apps_status.textContent = ''
  apps_list.innerHTML = apps.map(app => `
      <div style="border: 1px solid #ccc; padding: 10px; margin: 5px 0;">
        <strong>${app.name || app.id}</strong>
        <p>${app.structures.length} structure(s)</p>
        <button class="join-app-btn" data-app-id="${app.id}">Join App</button>
      </div>
    `).join('')
  apps_list.querySelectorAll('.join-app-btn').forEach(btn => {
    btn.addEventListener('click', () => handle_join_app(btn.dataset.appId))
  })
}

/***************************************
HANDLE JOIN APP
***************************************/
async function handle_join_app (app_id) {
  const apps_status = container.querySelector('.apps-status')
  apps_status.textContent = `Joining ${app_id}...`
  const app = await vault.get_app(app_id)
  if (!app || !app.structures) {
    apps_status.textContent = 'Error: App not found'
    return
  }
  vault.session_set_joined_app(app_id)
  vault.complete_authentication()
  show_system_bar()
}

/***************************************
LOAD MNEMONIC HANDLER (NOT IMPLEMENTED YET)
***************************************/
function handle_load () {
  const mnemonic = container.querySelector('.mnemonic-input').value.trim()
  if (!mnemonic) return alert('Please enter a mnemonic phrase.')
  alert('Load from mnemonic is not implemented yet.')
}

/***************************************
RESET ALL DATA HANDLER
***************************************/
async function handle_reset_all_data () {
  if (!confirm('Delete all data?')) return
  try {
    await vault.reset_all_data()
    location.reload()
  } catch (err) {
    alert('Reset error: ' + err.message)
  }
}

/***************************************
EVENT LISTENERS SETUP
***************************************/
container.querySelector('.make-btn').addEventListener('click', () => {
  container.querySelector('.initial-buttons').style.display = 'none'
  container.querySelector('.make-form').style.display = 'block'
})

container.querySelector('.join-btn').addEventListener('click', () => {
  container.querySelector('.initial-buttons').style.display = 'none'
  container.querySelector('.join-form').style.display = 'block'
})

container.querySelector('.load-btn').addEventListener('click', () => {
  container.querySelector('.initial-buttons').style.display = 'none'
  container.querySelector('.load-form').style.display = 'block'
})

container.querySelectorAll('.back-btn').forEach(handle_back_button)

function handle_back_button (btn) {
  btn.addEventListener('click', () => {
    container.querySelectorAll('.make-form, .join-form, .load-form').forEach(form => {
      form.style.display = 'none'
    })
    container.querySelector('.initial-buttons').style.display = 'block'
  })
}

container.querySelector('.make-network-btn').addEventListener('click', handle_seed)
container.querySelector('.join-with-invite-btn').addEventListener('click', handle_pair)
container.querySelector('.load-mnemonic-btn').addEventListener('click', handle_load)
container.querySelector('.reset-all-btn').addEventListener('click', handle_reset_all_data)

/***************************************
AUTO-AUTHENTICATION CHECK
***************************************/
const existing_username = vault.session_get_username()
const auth_mode = vault.session_get_auth_mode()
const joined_app = vault.session_get_joined_app()
const pending_invite_code = vault.session_get_pending_invite()

// auto authenticate if user has joined an app, or show app picker if exited
// so we could switch between apps
if (existing_username && joined_app) {
  show_system_bar()
  vault.authenticate({ username: existing_username, mode: auth_mode })
} else if (existing_username && auth_mode === 'pair' && pending_invite_code) {
  // Device B refresh: resume interrupted pairing with the stored invite code
  container.querySelector('.join-form').style.display = 'block'
  container.querySelector('.initial-buttons').style.display = 'none'
  container.querySelector('.invite-code-input').value = pending_invite_code
  handle_pair()
} else if (existing_username) {
  show_system_bar()
  vault.on_vault_ready(show_app_selection)
  vault.authenticate({ username: existing_username, mode: auth_mode, defer_resolve: true })
}

/***************************************
app selection
Shows app picker when user has exited an app
or paired device hasn't picked an app yet.
***************************************/
async function show_app_selection () {
  const picker = document.createElement('div')
  picker.style.cssText = 'padding:20px;font-family:monospace'
  picker.innerHTML = '<h3>Select App</h3><div class="apps">Loading apps...</div>'
  document.body.appendChild(picker)
  await vault.get_vault_bee().update()
  const apps = await vault.list_apps()
  if (!apps || !apps.length) { picker.querySelector('.apps').textContent = 'No apps found.'; return }
  picker.querySelector('.apps').innerHTML = apps.map(function (app) {
    return '<div style="border:1px solid #ccc;padding:10px;margin:5px 0"><strong>' +
      (app.name || app.id) + '</strong> (' + app.structures.length + ' structures)' +
      ' <button class="launch-btn" data-id="' + app.id + '">Launch</button></div>'
  }).join('')
  picker.addEventListener('click', function (e) {
    if (!e.target.classList.contains('launch-btn')) return
    vault.session_set_joined_app(e.target.dataset.id)
    vault.complete_authentication()
    picker.remove()
  })
}

/***************************************
SYSTEM BAR
top level system UI bar
contains tabs for: invite, devices, relays,
vault log, and reset.
***************************************/
function show_system_bar () {
  container.remove()
  const sys = document.createElement('div')
  sys.style.cssText = 'font-family:monospace;font-size:13px;border-bottom:1px solid #ccc;background:#f5f5f5'
  sys.innerHTML = `
    <div class="header" style="display:flex;align-items:center;padding:4px 10px;gap:6px">
      <span>System</span>
      <span style="opacity:0.5">p2p-news-app</span>
      <span class="user-label" style="font-weight:bold"></span>
      <span style="flex:1"></span>
      <button class="toggle-btn">▼ Expand</button>
      <button class="exit-btn">Exit App</button>
    </div>
    <div class="panel" style="display:none;border-top:1px solid #ccc;padding:6px 10px">
      <div style="display:flex;gap:4px;margin-bottom:6px;flex-wrap:wrap">
        <button class="tab-btn" data-section="invite">Invite</button>
        <button class="tab-btn" data-section="devices">Devices</button>
        <button class="tab-btn" data-section="relays">Relays</button>
        <button class="tab-btn" data-section="audit">Vault Log</button>
        <button class="reset-btn" style="margin-left:auto">Reset All Data</button>
      </div>
      <div class="section-invite" style="display:none">
        <button class="create-invite-btn">Generate Invite Code</button>
        <div class="invite-result" style="margin-top:4px"></div>
        <div class="verify-area" style="display:none;margin-top:6px">
          <span>6-digit code from new device: </span>
          <input class="verification-input" maxlength="6" style="width:70px;font-family:monospace">
          <button class="verify-btn">Verify</button>
          <button class="deny-btn">Deny</button>
        </div>
      </div>
      <div class="section-devices" style="display:none">
        <div class="devices-list">Loading...</div>
      </div>
      <div class="section-relays" style="display:none">
        <div style="margin-bottom:4px">
          <input class="relay-input" placeholder="ws://... or wss://..." style="width:300px;font-family:monospace">
          <button class="relay-add-btn">Add</button>
        </div>
        <div class="relays-list">No relays configured.</div>
      </div>
      <div class="section-audit" style="display:none">
        <div class="audit-meta" style="font-size:11px;color:#666;margin-bottom:4px">
          <span class="audit-count">0 entries</span>
        </div>
        <div class="audit-list" style="max-height:400px;overflow-y:auto;width:100%;border:1px solid #ddd;background:#fafafa;word-break:break-word">No entries.</div>
      </div>
    </div>
  `
  document.body.appendChild(sys)

  /***************************************
  EVENT LISTENERS
  ***************************************/
  sys.querySelector('.toggle-btn').addEventListener('click', handle_toggle)
  sys.querySelector('.create-invite-btn').addEventListener('click', handle_create_invite)
  sys.querySelector('.verify-btn').addEventListener('click', handle_verify)
  sys.querySelector('.deny-btn').addEventListener('click', handle_deny)
  sys.querySelector('.reset-btn').addEventListener('click', handle_reset_all_data)
  sys.querySelector('.exit-btn').addEventListener('click', handle_exit_app)
  sys.addEventListener('click', handle_panel_click)
  const username = vault.session_get_username()
  if (username) sys.querySelector('.user-label').textContent = username

  /***************************************
  TAB SWITCHING
  ***************************************/
  let active_tab = null
  sys.querySelectorAll('.tab-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const s = btn.dataset.section
      // Toggle off
      if (active_tab === s) {
        sys.querySelector('.section-' + s).style.display = 'none'
        active_tab = null
        return
      }
      // Switch tab
      if (active_tab) sys.querySelector('.section-' + active_tab).style.display = 'none'
      sys.querySelector('.section-' + s).style.display = 'block'
      active_tab = s
      if (s === 'devices') load_devices()
      if (s === 'relays') load_relays()
      if (s === 'audit') load_vault_audit()
    })
  })
  vault.on_update(function () {
    if (active_tab === 'devices') load_devices()
    if (active_tab === 'relays') load_relays()
    if (active_tab === 'audit') load_vault_audit()
  })
  restore_pending_invites_if_any()

  /***************************************
  TOGGLE EXPAND / COLLAPSE
  ***************************************/
  function handle_toggle () {
    const panel = sys.querySelector('.panel')
    const open = panel.style.display !== 'none'
    panel.style.display = open ? 'none' : 'block'
    sys.querySelector('.toggle-btn').textContent = open ? '▼ Expand' : '▲ Collapse'
  }

  /***************************************
  DEVICES
  ***************************************/
  function get_own_key () {
    const vb = vault.get_vault_bee()
    return vb?.base?.local ? vb.base.local.key.toString('hex') : null
  }
  async function load_devices () {
    const el = sys.querySelector('.devices-list')
    try {
      const devices = await vault.get_paired_devices()
      if (!devices.length) { el.textContent = 'No paired devices yet.'; return }
      el.innerHTML = ''
      const own = get_own_key()
      for (const d of devices) {
        const div = document.createElement('div')
        div.style.cssText = 'border:1px solid #ccc;padding:4px 6px;margin:3px 0;font-family:monospace;font-size:12px'
        const is_self = own && d.vault_bee_writer === own
        const keys = Object.entries(d).filter(function (kv) { return kv[0].endsWith('_writer') }).map(function (kv) { return kv[0].replace('_writer', '') + ': ' + kv[1] }).join('\n')
        div.innerHTML = '<strong>' + (d.name || '?') + '</strong>' +
          (is_self ? ' (This Device)' : '') +
          ' <small>' + (d.added_date || '') + '</small>' +
          '<details><summary>Keys</summary><pre style="font-size:10px;white-space:pre-wrap;word-break:break-all">' + keys + '</pre></details>' +
          (is_self ? '' : '<button class="remove-device-btn" data-device-id="' + (d.vault_bee_writer || '') + '">Remove</button>')
        el.appendChild(div)
      }
    } catch (err) { el.textContent = 'Error: ' + err.message }
  }

  /***************************************
  DELEGATED CLICK HANDLER
  ***************************************/
  function handle_panel_click (e) {
    const t = e.target
    if (t.classList.contains('remove-device-btn')) {
      if (!confirm('Remove this device?')) return
      t.disabled = true
      vault.get_paired_devices().then(function (devs) {
        const dev = devs.find(function (d) { return d.vault_bee_writer === t.dataset.deviceId })
        if (!dev) { alert('Not found'); return }
        vault.remove_device(dev).then(function (ok) { if (ok) load_devices() })
      })
    }
    if (t.classList.contains('cancel-invite-btn')) handle_cancel_invite()
    if (t.classList.contains('relay-add-btn')) handle_relay_add()
    if (t.classList.contains('relay-remove-btn')) handle_relay_remove(t.dataset.relay)
    if (t.classList.contains('relay-default-btn')) handle_relay_set_default(t.dataset.relay)
  }

  /***************************************
  RELAYS
  ***************************************/
  async function load_relays () {
    const el = sys.querySelector('.relays-list')
    try {
      const relays = await vault.vault_get('config/relays') || []
      const def = await vault.vault_get('config/default_relay')
      if (!relays.length) { el.textContent = 'No relays configured.'; return }
      el.innerHTML = relays.map(function (url) {
        const is_def = url === def
        return '<div style="display:flex;align-items:center;gap:4px;margin:2px 0">' +
          '<span style="flex:1;word-break:break-all">' + url + '</span>' +
          '<button class="relay-default-btn" data-relay="' + url + '">' + (is_def ? '✓ Default' : 'Set Default') + '</button>' +
          '<button class="relay-remove-btn" data-relay="' + url + '">✕</button></div>'
      }).join('')
    } catch (err) { el.textContent = 'Error: ' + err.message }
  }
  async function handle_relay_add () {
    const input = sys.querySelector('.relay-input')
    const url = input.value.trim()
    if (!url) return
    const relays = await vault.vault_get('config/relays') || []
    if (!relays.includes(url)) { relays.push(url); await vault.vault_put('config/relays', relays) }
    input.value = ''
    load_relays()
  }
  async function handle_relay_remove (url) {
    const relays = await vault.vault_get('config/relays') || []
    await vault.vault_put('config/relays', relays.filter(function (r) { return r !== url }))
    if (await vault.vault_get('config/default_relay') === url) await vault.vault_del('config/default_relay')
    load_relays()
  }
  async function handle_relay_set_default (url) {
    await vault.vault_put('config/default_relay', url)
    load_relays()
  }

  /***************************************
  INVITE / PAIRING
  ***************************************/
  async function handle_create_invite () {
    const result = await vault.create_vault_invite()
    const el = sys.querySelector('.invite-result')
    el.innerHTML = '<input readonly value="' + result.invite_code + '" style="width:300px;font-family:monospace"> <button class="copy-btn">Copy</button> <button class="cancel-invite-btn">Cancel Invite</button>'
    el.querySelector('.copy-btn').addEventListener('click', function () {
      navigator.clipboard.writeText(result.invite_code)
      el.querySelector('.copy-btn').textContent = 'Copied!'
    })
    await vault.setup_vault_pairing({
      invite: result.invite,
      username: vault.session_get_username() || 'Unknown',
      on_verification_needed: function () { sys.querySelector('.verify-area').style.display = 'block' },
      on_paired: handle_paired
    })
  }
  function handle_paired (result) {
    sys.querySelector('.verify-area').style.display = 'none'
    if (!result?.vault_bee_writer) return
    vault.get_paired_devices().then(function (devs) {
      vault.vault_put('paired_devices/' + result.vault_bee_writer, {
        name: 'Device ' + (devs.length + 1),
        added_date: new Date().toLocaleString(),
        vault_bee_writer: result.vault_bee_writer,
        vault_audit_writer: result.vault_audit_writer
      })
    })
  }
  async function handle_verify () {
    const code = sys.querySelector('.verification-input').value.trim()
    if (!code || code.length !== 6) return alert('Enter 6 digits')
    const result = await vault.verify_vault_pairing(code)
    if (result?.multiple_attempts) alert(result.total_attempts + ' device(s) attempted to pair.')
    sys.querySelector('.verify-area').style.display = 'none'
    sys.querySelector('.invite-result').innerHTML = ''
  }
  function handle_deny () {
    vault.deny_vault_pairing()
    sys.querySelector('.verify-area').style.display = 'none'
    sys.querySelector('.invite-result').innerHTML = ''
  }
  async function handle_cancel_invite () {
    await vault.cancel_vault_invite()
    sys.querySelector('.invite-result').innerHTML = ''
    sys.querySelector('.verify-area').style.display = 'none'
  }

  /***************************************
  VAULT AUDIT LOG
  ***************************************/
  async function load_vault_audit () {
    const el = sys.querySelector('.audit-list')
    const count_el = sys.querySelector('.audit-count')
    try {
      const audit = vault.get_vault_audit()
      if (!audit) { el.textContent = 'Not available.'; return }
      await audit.ready()
      await audit.update()
      const entries = await audit.read()
      if (!entries?.length) { el.textContent = 'No entries yet.'; count_el.textContent = '0 entries'; return }
      count_el.textContent = entries.length + ' entries'
      el.innerHTML = entries.slice().reverse().map(function (e) {
        const time = e.data?.timestamp ? new Date(e.data.timestamp).toLocaleString() : ''
        const data = Object.entries(e.data || {}).filter(function (kv) { return kv[0] !== 'timestamp' }).map(function (kv) { return kv[0] + ': ' + JSON.stringify(kv[1]) }).join(', ')
        return '<div style="border-bottom:1px solid #eee;padding:4px 6px;font-size:11px;background:#fff"><b>' + (e.type || '?') + '</b> <small style="color:#999">' + time + '</small>' + (data ? '<br><small style="color:#666;word-break:break-all">' + data + '</small>' : '') + '</div>'
      }).join('')
    } catch (err) { el.textContent = 'Error: ' + err.message; count_el.textContent = 'Error' }
  }

  /***************************************
  EXIT APP
  ***************************************/
  function handle_exit_app () {
    vault.session_set_joined_app('')
    location.reload()
  }

  /***************************************
  RESTORE PENDING INVITES
  re-setup the pairing member on refresh so we rejoin the topic.
  ***************************************/
  async function restore_pending_invites_if_any () {
    await vault.user.catch(function () { })
    const stored = await vault.restore_pending_invites({
      username: vault.session_get_username() || 'Unknown',
      on_verification_needed: function () { sys.querySelector('.verify-area').style.display = 'block' },
      on_paired: handle_paired
    })
    if (!stored) return
    if (sys.querySelector('.panel').style.display === 'none') handle_toggle()
    if (active_tab && active_tab !== 'invite') sys.querySelector('.section-' + active_tab).style.display = 'none'
    sys.querySelector('.section-invite').style.display = 'block'
    active_tab = 'invite'
    const el = sys.querySelector('.invite-result')
    el.innerHTML = '<input readonly value="' + stored.invite_code + '" style="width:300px;font-family:monospace"> <button class="copy-btn">Copy</button> <button class="cancel-invite-btn">Cancel Invite</button>'
    el.querySelector('.copy-btn').addEventListener('click', function () {
      navigator.clipboard.writeText(stored.invite_code)
      el.querySelector('.copy-btn').textContent = 'Copied!'
    })
  }
}
