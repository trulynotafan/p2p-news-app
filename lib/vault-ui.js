/* global vault */
// Vault UI - Handles initial authentication (Seed/Pair/Load)
// Loaded as standalone bundle by datashell
// Receives vault parameter from datashell via async function

const blog_app = require('p2p-news-app')

// This function is called by datashell with vault parameter
async function setup(vault) {
  // Note: datashell already checked authentication, so we always show UI here

  // Show authentication UI
  const container = document.createElement('div')
  container.className = 'vault-ui'
  container.innerHTML = `
    <div class="login">
      <h3>P2P News App</h3>
      <div class="make-form" style="display: none; margin-top: 10px;">
        <button class="back-btn" style="margin-bottom: 5px;">← Back</button><br>
        <input class="username-input" placeholder="Your Name">
        <button class="make-network-btn">Create Blog</button>
      </div>
      <div class="join-form" style="display: none; margin-top: 10px;">
        <button class="back-btn" style="margin-bottom: 5px;">← Back</button><br>
        <input class="invite-code-input" placeholder="Paste invite code here" style="width: 300px; margin-bottom: 5px;">
        <br>
        <button class="join-with-invite-btn">Join with Invite</button>
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

  // Return a promise that resolves when authenticated
  return new Promise((resolve, reject) => {
    let api = null

    // Seed: Create new blog
    async function handle_seed() {
      const user = container.querySelector('.username-input').value.trim()
      if (!user) return alert('Please enter your name.')

      try {
        container.querySelector('.status').textContent = 'Creating blog...'
        
        // Create blog app
        api = blog_app(vault)
        await api.init_blog({ username: user })
        
        // Save username
        localStorage.setItem('username', user)
        
        // Remove UI and resolve promise to continue to webapp-ui
        document.body.removeChild(container)
        resolve({ 
          authenticated: true, 
          username: user, 
          mode: 'seed',
          api 
        })
      } catch (err) {
        container.querySelector('.status').textContent = 'Error: ' + err.message
        console.error('[vault-ui] Seed error:', err)
      }
    }

    // Pair: Join existing blog
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
        
        // Create blog app
        api = blog_app(vault)
        
        // Join with invite
        await api.init_blog({
          username: 'joining-user',
          invite_code: invite_code,
          on_verification_code_ready: (verification_code) => {
            container.querySelector('.status').innerHTML = 
              `🟡 Pairing...<br><strong style="font-size: 1.2em; color: #007bff;">Verification Code: ${verification_code}</strong><br><small>Share this code with Device A</small>`
          }
        })
        
        // Get username from pairing result
        const pairing_result = api.get_pairing_result()
        const username = pairing_result?.username || 'User'
        
        // Save username
        localStorage.setItem('username', username)
        
        // Remove UI and resolve promise to continue to webapp-ui
        document.body.removeChild(container)
        resolve({ 
          authenticated: true, 
          username: username, 
          mode: 'pair',
          api 
        })
      } catch (err) {
        let error_msg = err.message
        
        if (error_msg.includes('Pairing denied by user')) {
          alert('Pairing was denied by Main Device. Click OK to restart.')
          await handle_reset_all_data()
          return
        }
        
        if (error_msg.includes('Pairing rejected')) {
          error_msg = 'Pairing rejected: Verification code does not match.'
        } else if (error_msg.includes('Unknown invite version')) {
          error_msg = 'Invite code is corrupted or incomplete.'
        }
        
        container.querySelector('.status').textContent = '🔴 Error: ' + error_msg
        console.error('[vault-ui] Pair error:', err)
      }
    }

    // Load: Restore from mnemonic (NOT IMPLEMENTED YET)
    function handle_load() {
      const mnemonic = container.querySelector('.mnemonic-input').value.trim()
      if (!mnemonic) return alert('Please enter a mnemonic phrase.')
      alert('Load from mnemonic is not implemented yet.')
      console.log('[vault-ui] Load mnemonic:', mnemonic)
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
  })
}

// Export the setup function for datashell
module.exports = setup
