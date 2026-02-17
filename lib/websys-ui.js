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
    localStorage.setItem('username', username)
    localStorage.setItem('auth_mode', 'seed')
    // Remove UI
    document.body.removeChild(container)
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
    container.querySelector('.status').textContent = 'Pairing...'
    // Store invite code for app to use
    localStorage.setItem('pending_invite_code', invite_code)
    localStorage.setItem('auth_mode', 'pair')
    // For now, use placeholder username
    const username = 'pairing-user'
    localStorage.setItem('username', username)
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
        localStorage.setItem('username', auth_data.username)
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
          </div>
      `
      document.body.appendChild(overlay)
    }
    vault.user.catch(handle_pairing_error)
    function handle_pairing_error (err) {
      if (overlay) document.body.removeChild(overlay)
      alert('Pairing failed: ' + err.message)
      localStorage.clear()
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
  localStorage.setItem('joined_app', app_id)
  vault.complete_authentication()
  document.body.removeChild(container)
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
    localStorage.clear()
    const databases = await indexedDB.databases()
    for (const db of databases) {
      if (db.name && (db.name.includes('blogs-') || db.name.includes('random-access-web') || db.name.includes('identity-'))) {
        indexedDB.deleteDatabase(db.name)
      }
    }
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
const existing_username = localStorage.getItem('username')
const auth_mode = localStorage.getItem('auth_mode') || 'seed'
const joined_app = localStorage.getItem('joined_app')

// For pair mode, only auto-authenticate if user has joined an app
if (existing_username && (auth_mode === 'seed' || joined_app)) {
  document.body.removeChild(container)
  vault.authenticate({
    username: existing_username,
    mode: auth_mode
  })
}