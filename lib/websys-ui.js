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

// Seed: Create new account
async function handle_seed() {
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

// Pair: Join existing account
async function handle_pair() {
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
    
    vault.authenticate({
      username: username,
      mode: 'pair',
      invite_code: invite_code,
      on_verification_code: (verification_code) => {
        overlay = document.createElement('div')
        overlay.style.cssText = 'position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: white; display: flex; align-items: center; justify-content: center;'
        overlay.innerHTML = `
          <div style="text-align: center;">
            <p>Verification Code:</p>
            <h1>${verification_code}</h1>
            <p>Waiting for Device A to verify...</p>
          </div>
        `
        document.body.appendChild(overlay)
      }
    })
    
    // Wait for authentication to complete 
    await vault.user
    
    // remove container after successful authentication
    if (overlay) document.body.removeChild(overlay)
    document.body.removeChild(container)
    
  } catch (err) {
    // Remove overlay if it exists
    const overlay = document.querySelector('div[style*="position: fixed"]')
    if (overlay) document.body.removeChild(overlay)
    
    if (err.message.includes('Pairing denied by user')) {
      alert('Pairing was denied by Main Device. Click OK to restart.')
      await handle_reset_all_data()
      return
    }

    alert('Pairing error: ' + err.message)
    await handle_reset_all_data()
  }
}

// Load: Restore from mnemonic (NOT IMPLEMENTED YET)
function handle_load() {
  const mnemonic = container.querySelector('.mnemonic-input').value.trim()
  if (!mnemonic) return alert('Please enter a mnemonic phrase.')
  alert('Load from mnemonic is not implemented yet.')
}

// Reset all data
async function handle_reset_all_data() {
  if (!confirm('Delete all data?')) return

  try {
    localStorage.clear()
    const databases = await window.indexedDB.databases()
    for (const db of databases) {
      if (db.name && (db.name.includes('blogs-') || db.name.includes('random-access-web') || db.name.includes('identity-'))) {
        window.indexedDB.deleteDatabase(db.name)
      }
    }
    window.location.reload()
  } catch (err) {
    alert('Reset error: ' + err.message)
  }
}

// Event listeners
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

container.querySelectorAll('.back-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    container.querySelectorAll('.make-form, .join-form, .load-form').forEach(form => {
      form.style.display = 'none'
    })
    container.querySelector('.initial-buttons').style.display = 'block'
  })
})

container.querySelector('.make-network-btn').addEventListener('click', handle_seed)
container.querySelector('.join-with-invite-btn').addEventListener('click', handle_pair)
container.querySelector('.load-mnemonic-btn').addEventListener('click', handle_load)
container.querySelector('.reset-all-btn').addEventListener('click', handle_reset_all_data)

// Check if already authenticated
const existing_username = localStorage.getItem('username')
if (existing_username) {
  document.body.removeChild(container)
  vault.authenticate({
    username: existing_username,
    mode: localStorage.getItem('auth_mode') || 'seed'
  })
}
