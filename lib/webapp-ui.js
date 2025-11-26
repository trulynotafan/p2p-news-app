// Web App UI which receives vault from datashell
// vault contains the identity API

const blog_app = require('p2p-news-app')

// webapp-ui function, called by datashell with identity_api parameter
function webapp_ui(vault) {
  console.log('[webapp-ui] Starting with vault:', vault)

  // Global state
  let store
let username = localStorage.getItem('username') || ''
let current_view
let is_ready = false
let is_joining = false
let swarm = null
let api = null // Will be initialized when blog app is created
let pairing_manager = null
let default_relay = null

// Relay helpers
const get_relays = () => {
  try { return JSON.parse(localStorage.getItem('relays') || '[]') } catch { return [] }
}
const get_default_relay = () => localStorage.getItem('default_relay') || null
const add_relay = (url) => {
  const relays = get_relays()
  if (!relays.includes(url)) {
    relays.push(url)
    localStorage.setItem('relays', JSON.stringify(relays))
  }
}
const remove_relay = (url) => {
  localStorage.setItem('relays', JSON.stringify(get_relays().filter(r => r !== url)))
  if (get_default_relay() === url) localStorage.removeItem('default_relay')
}
const set_default_relay = (url) => {
  localStorage.setItem('default_relay', url)
  default_relay = url
}

console.log('[webapp-ui] Setting up HTML structure...')
// Basic HTML structure
document.body.innerHTML = `
    <div class="app">
      <div class="login" style="display: ${username ? 'none' : 'block'}">
        <h3>P2P News App</h3>
        <div class="make-form" style="display: none; margin-top: 10px;">
          <button class="back-btn" style="margin-bottom: 5px;">← Back</button><br>
          <input class="username-input" value="${username}" placeholder="Your Name">
          <button class="make-network-btn">Create Blog</button>
        </div>
        <div class="join-form" style="display: none; margin-top: 10px;">
          <button class="back-btn" style="margin-bottom: 5px;">← Back</button><br>
          <input class="verification-code-input" placeholder="Enter 6-digit verification code" style="width: 300px; margin-bottom: 5px;" maxlength="6">
          <br>
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
      </div>
      <div class="main" style="display: ${username ? 'block' : 'none'}">
        <div>Status: <span class="connection-status">Disconnected</span></div>
        <nav>
          <button data-view="news">News</button>
          <button data-view="blog">My Blog</button>
          <button data-view="explore">Explore</button>
          <button data-view="post">New Post</button>
          <button data-view="config">Config</button>
        </nav>
        <style>
          body { font-family: monospace; }
          nav button.active { background-color: #007bff; color: white; }
        </style>
        <div class="view"></div>
      </div>
    </div>
  `

  // Utility functions
  const format_date = timestamp => new Date(timestamp).toLocaleString()
  function escape_html (str) {
    if (!str) return ''
    function get_html_entity (tag) {
      const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
      return entities[tag]
    }
    return str.replace(/[&<>"']/g, get_html_entity)
  }

  // Setup connection status UI
  function setup_connection_status (swarm) {
    const status_el = document.querySelector('.connection-status')
    if (swarm) {
      // Set initial status
      is_joining = false
      if (swarm.connections.size > 0) {
        status_el.textContent = `🟢 Connected as ${username} (${swarm.connections.size} peers)`
      } else {
        status_el.textContent = `🟢 Joined swarm as ${username} (waiting for peers...)`
      }

      function handle_swarm_connection () {
        status_el.textContent = `🟢 Connected as ${username} (${swarm.connections.size} peers)`
        if (current_view) render_view(current_view)
      }

      function handle_swarm_disconnection () {
        status_el.textContent = `🟢 Connected as ${username} (${swarm.connections.size} peers)`
      }

      swarm.on('connection', handle_swarm_connection)
      swarm.on('disconnection', handle_swarm_disconnection)
    } else {
      is_joining = false
      status_el.textContent = '🟠 Offline mode (relay not available)'
    }
  }

  // Core functionality
  async function make_network () {
    const user = document.querySelector('.username-input').value.trim() || username
    if (!user) return alert('Please enter your name to make.')

    localStorage.setItem('username', user)
    username = user

    document.querySelector('.login').style.display = 'none'
    document.querySelector('.main').style.display = 'block'

    try {
      document.querySelector('.connection-status').textContent = 'Connecting to relay...'
      is_joining = true

      // Load default relay if set
      default_relay = get_default_relay()
      
      // Create blog app with vault (identity API)
      api = blog_app(vault)

      function handle_blog_update () {
        if (current_view) render_view(current_view)
      }

      api.on_update(handle_blog_update)

      // Init blog with relay if set
      const init_options = { username }
      if (default_relay) init_options.relay = default_relay
      console.log('[webapp-ui] Calling api.init_blog with options:', init_options)
      const result = await api.init_blog(init_options)
      console.log('[webapp-ui] init_blog succeeded, result:', result)
      store = result.store
      swarm = result.swarm
      
      setup_connection_status(swarm)

      is_ready = true
      is_joining = false

      show_view('news')
    } catch (err) {
      is_joining = false
      const error_msg = err.message
      console.error('[webapp-ui] make_network error:', err)
      console.error('[webapp-ui] error message:', error_msg)
      if (error_msg.includes('Relay connection failed') || error_msg.includes('Relay connection closed')) {
        try {
          const result = await api.init_blog({ username, offline_mode: true })
          store = result.store
          is_ready = true
          setup_connection_status(null)
          show_view('news')
        } catch (e) {}
        
        const status_el = document.querySelector('.connection-status')
        status_el.innerHTML = `🔴 Relay Error: ${error_msg} <button id="relay_retry_btn">Retry</button> <button id="relay_reset_btn">Reset to Default</button>`
        document.getElementById('relay_retry_btn').addEventListener('click', () => window.location.reload())
        document.getElementById('relay_reset_btn').addEventListener('click', () => {
          localStorage.removeItem('default_relay')
          window.location.reload()
        })
      } else {
        document.querySelector('.connection-status').textContent = `🔴 Error: ${error_msg}`
      }
    }
  }

  // Join existing network with invite
  async function join_network () {
    const verification_code = document.querySelector('.verification-code-input').value.trim()
    const invite_code = document.querySelector('.invite-code-input').value.trim()
    if (!verification_code) return alert('Please enter the 6-digit verification code.')
    if (!verification_code.match(/^\d{6}$/)) return alert('Verification code must be exactly 6 digits.')
    if (!invite_code) return alert('Please enter an invite code.')
    
    // Validate invite code format and length
    try {
      const decoded = Buffer.from(invite_code, 'base64')
      // Blind pairing invites should be at least a certain minimum length
      if (decoded.length < 32) {
        return alert('Invite code is too short. Make sure you copied the entire code.')
      }
    } catch (err) {
      return alert('Invalid invite code format. Make sure you copied it correctly.')
    }

    document.querySelector('.login').style.display = 'none'
    document.querySelector('.main').style.display = 'block'

    try {
      document.querySelector('.connection-status').textContent = 'Connecting...'
      is_joining = true

      // Create blog app with vault (identity API)
      api = blog_app(vault)

      // Show "Getting ready..." status
      document.querySelector('.connection-status').textContent = '🟡 Getting ready...'
      
      // Initialize blog with invite code and verification code
      const result = await api.init_blog({
        username: 'joining-user',
        invite_code: invite_code,
        verification_code: verification_code
      })
      
      store = result.store
      swarm = result.swarm
      
      api.on_update(() => { if (current_view) render_view(current_view) })
      
      // Get username from pairing result
      const pairing_result = api.get_pairing_result()
      
      if (pairing_result?.username) {
        username = pairing_result.username
        localStorage.setItem('username', username)
        console.log('Username received from pairing:', username)
      } else {
        console.warn('[webapp-ui] No username in pairing result, using default')
        username = 'User'
      }
      
      setup_connection_status(swarm)
      is_ready = true
      is_joining = false
      
      show_view('news')
    } catch (err) {
      is_joining = false
      let error_msg = err.message
      if (error_msg.includes('Pairing rejected')) {
        error_msg = 'Pairing rejected: Verification code does not match. Please check the code on the first device and try again.'
      } else if (error_msg.includes('Unknown invite version')) {
        error_msg = 'Invite code is corrupted or incomplete. Please copy it again from the first device.'
      } else if (error_msg.includes('invite')) {
        error_msg = 'Invalid invite code. Please check and try again.'
      }
      document.querySelector('.connection-status').textContent = `🔴 Error: ${error_msg}`
      console.error('Join error:', err)
    }
  }

  // Load from mnemonic
  function load_from_mnemonic () {
    const mnemonic = document.querySelector('.mnemonic-input').value.trim()
    if (!mnemonic) return alert('Please enter a mnemonic phrase.')
    console.log('This still needs implementation')
    console.log('Mnemonic entered:', mnemonic)
  }

  // View system
  function show_view (name) {
    current_view = name
    function handle_nav_button_toggle (btn) {
      btn.classList.toggle('active', btn.dataset.view === name)
    }
    document.querySelectorAll('nav button').forEach(handle_nav_button_toggle)
    render_view(name)
  }

  // Render function (a bit simplified than before..)
  async function render_view (view, ...args) {
    const view_el = document.querySelector('.view')

    if (is_joining) {
      view_el.innerHTML = '<p>Joining, please wait...</p>'
      return
    }

    if (!is_ready && view !== 'explore') return
    view_el.innerHTML = 'Loading...'

    const renderers = {
      news: async () => {
        const peer_blogs = await api.get_peer_blogs()
        if (peer_blogs.size === 0) {
          view_el.innerHTML = '<p>No posts from subscribed peers yet. Go to the explore tab to find peers.</p>'
          return
        }
        let html = ''
        for (const [key, blog] of peer_blogs) {
          const profile = await api.get_profile(key)
          const display_name = profile ? profile.name : blog.username
          html += `<h2>${escape_html(display_name)}'s Blog (${escape_html(blog.title)})</h2>`
          if (blog.posts.length === 0) {
            html += '<p>No posts from this peer yet.</p>'
          } else {
            for (const post of blog.posts) {
              html += `<div class="post"><h3>${escape_html(post.title)}</h3><p>${escape_html(post.content)}</p><span>Posted by ${escape_html(display_name)} on: ${new Date(post.created).toLocaleString()}</span></div>`
            }
          }
        }
        view_el.innerHTML = html
      },

      blog: async () => {
        const profile = await api.get_profile()
        const display_name = profile ? profile.name : username
        view_el.innerHTML = `<h3>${escape_html(display_name)}'s Blog</h3>`
        const posts = await api.get_my_posts()
        if (posts.length === 0) return view_el.innerHTML += '<p>You have not written any posts yet. Go to New Post to create one.</p>'
        for (const post of posts) {
          const device_info = post.device_name ? ` • ${escape_html(post.device_name)}` : ''
          view_el.innerHTML += `<div class="post"><h4>${escape_html(post.title)}</h4><p>${escape_html(post.content)}</p><small>Posted on: ${format_date(post.created)}${device_info}</small></div>`
        }
      },

      explore: async () => {
        let html = '<h3>Explore Peers</h3>'
        const discovered = api.get_discovered_blogs()
        const subscribed_blogs = await api.get_peer_blogs()
        const subscribed_keys = Array.from(subscribed_blogs.keys())
        const my_key = api.get_autobase_key()

        if (discovered.size > 0) {
          html += '<h4>Discovered Peers</h4>'
          for (const [key, peer] of discovered) {
            if (key === my_key || subscribed_keys.includes(key)) continue
            const profile = await api.get_profile(key)
            const display_name = profile ? profile.name : peer.username
            const relay_info = peer.relay_url && !peer.relay_url.includes('localhost') ? `<p><small>Relay: ${escape_html(peer.relay_url)}</small></p>` : ''
            html += `<div><h5>${escape_html(display_name)}'s Blog (${escape_html(peer.title)})</h5><p><code>${key}</code></p>${relay_info}<button class="subscribe-btn" data-key="${key}">Subscribe</button></div><hr>`
          }
        }

        if (subscribed_blogs.size > 0) {
          html += '<h4>Subscribed Peers</h4>'
          for (const [key, blog] of subscribed_blogs) {
            if (key === my_key) continue
            const profile = await api.get_profile(key)
            const display_name = profile ? profile.name : blog.username
            const relay_info = blog.relay_url && !blog.relay_url.includes('localhost') ? `<p><small>Relay: ${escape_html(blog.relay_url)}</small></p>` : ''
            html += `<div><h5>${escape_html(display_name)}'s Blog (${escape_html(blog.title)})</h5><p><code>${key}</code></p>${relay_info}<button class="unsubscribe-btn" data-key="${key}">Unsubscribe</button></div><hr>`
          }
        }

        if (discovered.size === 0 && subscribed_blogs.size === 0) {
          html += '<p>No peers found yet. Wait for peers to be discovered.</p>'
        }
        
        view_el.innerHTML = html
      },

      post: () => {
        view_el.innerHTML = `<h3>Create New Post</h3><input class="post-title" placeholder="Title"><textarea class="post-content" placeholder="Content"></textarea><button class="publish-btn">Publish</button>`
        const publish_btn = view_el.querySelector('.publish-btn')
        publish_btn.addEventListener('click', handle_publish)
      },

      config: async () => {
        const my_key = api.get_autobase_key()
        const profile = await api.get_profile()
        const avatar_content = await api.get_avatar_content()
        const raw_data_buttons = await generate_raw_data_buttons()
        
        // Build stored invite section if codes exist (check from pairing_manager)
        let invite_section = `<div><h4>Create Invite</h4><p>Create an invite to share write access to your blog.</p><button class="create-invite-btn">Create Invite</button><div class="invite-result" style="margin-top: 10px;"></div></div>`
        const active_code = pairing_manager ? pairing_manager.get_verification_code() : null
        if (active_code) {
          const invite_code = document.querySelector('.invite-code-display')?.value || ''
          invite_section = `<div><h4>Active Invite</h4><p>Verification Code: <strong>${active_code}</strong></p><p>Invite Code:</p><input class="invite-code-display" readonly value="${invite_code}" style="width: 400px;"><button class="copy-invite-btn">Copy</button><p><small>Keep this page open while others join.</small></p></div><hr><div><h4>Create New Invite</h4><button class="create-invite-btn">Create Another Invite</button><div class="invite-result" style="margin-top: 10px;"></div></div>`
        }
        
        // Build relay list
        const relays = get_relays()
        const current_default = get_default_relay()
        let relay_list_html = relays.map(r => `<div style="margin: 5px 0;"><span>${escape_html(r)}</span> <button class="relay-default-btn" data-relay="${escape_html(r)}" style="margin-left: 10px;">${r === current_default ? '✓ Default' : 'Set Default'}</button> <button class="relay-remove-btn" data-relay="${escape_html(r)}" style="margin-left: 5px; background: #dc3545; color: white; border: none; padding: 2px 8px; cursor: pointer;">Remove</button></div>`).join('')
        
        view_el.innerHTML = `<h3>Configuration</h3><div><h4>My Profile</h4><p>Your current profile information:</p><div><p><strong>Name:</strong> ${profile ? escape_html(profile.name) : 'Loading...'}</p><div><strong>Avatar:</strong></div><div>${avatar_content ? (avatar_content.startsWith('data:') ? `<img src="${avatar_content}" style="max-width: 100px; max-height: 100px;">` : avatar_content) : 'Loading...'}</div></div><div><input type="file" class="avatar-upload" accept="image/*"><button class="upload-avatar-btn">Upload Profile Picture</button></div></div><hr><div><h4>My Blog Address</h4><p>Share this address with others so they can subscribe to your blog.</p><input class="blog-address-input" readonly value="${my_key}" size="70"><button class="copy-address-btn">Copy</button></div><hr><div><h4>Relays</h4><p>Add custom relays to connect through:</p><input class="relay-input" placeholder="ws://localhost:8080 or wss://relay.example.com" style="width: 400px;"><button class="relay-add-btn">Add Relay</button><div style="margin-top: 10px;">${relay_list_html || '<p style="color: #666;">No custom relays added</p>'}</div></div><hr>${invite_section}<hr><div><h4>Manual Subscribe</h4><p>Subscribe to a blog by its address.</p><input class="manual-key-input" placeholder="Blog Address" size="70"><button class="manual-subscribe-btn">Subscribe</button></div><hr><div><h4>Paired Devices</h4><p>Devices that have write access to this blog:</p><div class="paired-devices-list" style="background: #f5f5f5; padding: 10px; border-radius: 5px; margin: 10px 0;">Loading devices...</div></div><hr><div><h4>Show Raw Data</h4><button class="show-raw-data-btn">Show Raw Data</button><div class="raw-data-options" style="display: none; margin-top: 10px;">${raw_data_buttons}</div><pre class="raw-data-display" style="display: none; background: #f0f0f0; padding: 10px; margin-top: 10px; white-space: pre-wrap; max-height: 300px; overflow-y: auto;"></pre></div><hr><div><h4>Reset</h4><button class="reset-data-btn">Delete All My Data</button></div>`
        
        // Load paired devices after HTML is set
        const devices = await api.get_paired_devices()
        const devices_list = document.querySelector('.paired-devices-list')
        if (devices_list) {
          const my_key = api.get_local_key()
          
          if (devices.length === 0) {
            devices_list.innerHTML = '<p style="color: #666;">No paired devices yet. Create an invite to add devices.</p>'
          } else {
            let devices_html = ''
            for (const device of devices) {
              const is_my_device = device.metadata_writer === my_key
              let remove_data_attrs = ''
              for (const [key, value] of Object.entries(device)) {
                if (key.endsWith('_writer')) {
                  remove_data_attrs += ` data-${key.replace('_', '-')}="${escape_html(value)}"`
                }
              }
              const remove_btn = is_my_device ? '' : `<button class="remove-device-btn"${remove_data_attrs} style="margin-top: 10px; background: #dc3545; color: white; border: none; padding: 5px 10px; border-radius: 3px; cursor: pointer;">Remove Device</button>`
              const my_device_label = is_my_device ? ' <span style="color: #28a745;">(This Device)</span>' : ''
              let keys_html = ''
              for (const [key, value] of Object.entries(device)) {
                if (key.endsWith('_writer')) {
                  const structure_name = key.replace('_writer', '')
                  const display_name = structure_name.charAt(0).toUpperCase() + structure_name.slice(1)
                  keys_html += `<p><strong>${escape_html(display_name)}:</strong> ${escape_html(value)}</p>`
                }
              }
              devices_html += `<div style="margin-bottom: 15px; padding: 10px; background: white; border-radius: 3px;"><p style="margin: 5px 0;"><strong>${escape_html(device.name)}</strong>${my_device_label}</p><p style="margin: 5px 0; font-size: 0.9em; color: #666;">Added: ${escape_html(device.added_date)}</p><details style="margin-top: 5px;"><summary style="cursor: pointer; color: #007bff;">Show Keys</summary><div style="margin-top: 10px; font-family: monospace; font-size: 11px; word-break: break-all;">${keys_html}</div></details>${remove_btn}</div>`
            }
            devices_list.innerHTML = devices_html
          }
        }
      }
    }

    if (renderers[view]) await renderers[view]()
    else view_el.innerHTML = `View '${view}' not found.`
  }

  // Action handlers
  async function handle_publish () {
    const title = document.querySelector('.post-title').value
    const content = document.querySelector('.post-content').value
    if (!title || !content) return alert('Title and content are required.')
    try {
      await api.create_post(title, content)
      show_view('blog')
    } catch (err) {
      alert('Publish error: ' + err.message)
    }
  }

  async function handle_subscribe (key) {
    await api.subscribe(key)
    render_view('explore')
  }

  async function handle_unsubscribe (key) {
    await api.unsubscribe(key)
    render_view('explore')
  }

  async function handle_create_invite () {
    try {
      const result = await api.create_invite()
      const { invite_code, verification_code, pairing_manager: pm } = result
      pairing_manager = pm
      const invite_result = document.querySelector('.invite-result')
      invite_result.innerHTML = `
        <p>Verification Code: <strong>${verification_code}</strong></p>
        <p>Invite Code:</p>
        <input class="invite-code-display" readonly value="${invite_code}" style="width: 400px;">
        <button class="copy-invite-btn">Copy</button>
        <p><small>Keep this page open while others join.</small></p>
      `
      const copy_btn = invite_result.querySelector('.copy-invite-btn')
      copy_btn.addEventListener('click', () => {
        if (navigator.clipboard) navigator.clipboard.writeText(invite_code)
        else { const el = document.createElement('textarea'); el.value = invite_code; document.body.appendChild(el); el.select(); document.execCommand('copy'); document.body.removeChild(el) }
        const orig = copy_btn.textContent
        copy_btn.textContent = 'Copied!'
        setTimeout(() => { copy_btn.textContent = orig }, 2000)
      })
    } catch (err) {
      alert('Error creating invite: ' + err.message)
    }
  }

  async function handle_manual_subscribe () {
    const key = document.querySelector('.manual-key-input').value.trim()
    if (!key) return alert('Please enter a blog address.')
    const my_key = api.get_autobase_key()
    if (key === my_key) return alert("You can't subscribe to yourself.")
    const success = await api.subscribe(key)
    if (success) {
      alert('Successfully subscribed!')
      show_view('news')
    } else {
      alert('Failed to subscribe. The key may be invalid or the peer is offline.')
    }
  }

  async function handle_remove_device (button) {
    const device = {}
    for (const [key, value] of Object.entries(button.dataset)) {
      const snake_key = key.replace(/([A-Z])/g, '_$1').toLowerCase()
      device[snake_key] = value
    }
    if (!confirm('Remove this device? This will revoke write access from all drives.')) return
    try {
      button.disabled = true
      button.textContent = 'Removing...'
      const success = await api.remove_device(device)
      if (success) {
        show_view('config')
      } else {
        alert('Failed to remove device')
        button.disabled = false
        button.textContent = 'Remove Device'
      }
    } catch (err) {
      alert('Error: ' + err.message)
      button.disabled = false
      button.textContent = 'Remove Device'
    }
  }

  async function handle_reset_all_data () {
    if (!confirm('Delete all data?')) return
    try {
      localStorage.clear()
      const databases = await window.indexedDB.databases()
      for (const db of databases) {
        if (db.name && (db.name.includes('blogs-') || db.name.includes('random-access-web') || db.name.includes('identity-'))) {
          window.indexedDB.deleteDatabase(db.name)
        }
      }

      if (window.requestFileSystem || window.webkitRequestFileSystem) {
        const requestFileSystem = window.requestFileSystem || window.webkitRequestFileSystem
        function handle_file_system_cleanup (resolve, reject) {
          function handle_file_system_success (fs) {
            function handle_entries_read (entries) {
              if (!entries.length) return resolve()
              let completed = 0

              function handle_entry_removal () {
                completed++
                if (completed === entries.length) resolve()
              }

              function handle_entry_cleanup (entry) {
                entry.isFile ? entry.remove(handle_entry_removal, handle_entry_removal) : entry.removeRecursively(handle_entry_removal, handle_entry_removal)
              }

              entries.forEach(handle_entry_cleanup)
            }

            fs.root.createReader().readEntries(handle_entries_read, reject)
          }

          requestFileSystem(window.PERSISTENT, 1024 * 1024, handle_file_system_success, reject)
        }

        await new Promise(handle_file_system_cleanup)
      }

      if (store) {
        try { await store.close() } catch (err) {}
      }

      window.location.reload()
    } catch (err) {
      alert('Reset error: ' + err.message)
    }
  }

  // Generate raw data buttons dynamically (meaning based on the amount of data structures)
  async function generate_raw_data_buttons () {
    if (!api.get_structure_names) {
      // Fallback for old api
      return `
        <button class="raw-metadata-btn">Metadata</button>
        <button class="raw-drive-btn">Drive</button>
        <button class="raw-profile-btn">Profile</button>
        <button class="raw-events-btn">Events</button>
      `
    }
    
    const structure_names = api.get_structure_names()
    let buttons_html = ''
    
    for (const name of structure_names) {
      const display_name = name.charAt(0).toUpperCase() + name.slice(1)
      buttons_html += `<button class="raw-${name}-btn">${display_name}</button>`
    }
    
    return buttons_html
  }

  // Raw data handler
  function handle_raw_data (action, type) {
    const options = document.querySelector('.raw-data-options')
    const display = document.querySelector('.raw-data-display')
    
    if (action === 'toggle') {
      options.style.display = options.style.display === 'none' ? 'block' : 'none'
      display.style.display = 'none'
      return
    }
    
    display.textContent = 'Loading...'
    display.style.display = 'block'
    api.get_raw_data(type).then(data => display.textContent = data).catch(err => display.textContent = 'Error: ' + err.message)
  }

  function handle_upload_avatar () {
    const file_input = document.querySelector('.avatar-upload')
    const file = file_input.files[0]
    if (!file) {
      alert('Please select a file first')
      return
    }
    if (!file.type.startsWith('image/')) {
      alert('Please select an image file')
      return
    }
    const max_file_size = 1024 * 1024
    if (file.size > max_file_size) {
      alert(`File too large! Maximum size is 1MB. Your file is ${(file.size / 1024 / 1024).toFixed(2)}MB`)
      return
    }
    const reader = new FileReader()
    reader.onload = async function (e) {
      try {
        const image_data = new Uint8Array(e.target.result)
        await api.upload_avatar(image_data, file.name)
        alert('Profile picture uploaded successfully!')
        if (current_view === 'config') render_view('config')
      } catch (err) {
        alert('Upload failed: ' + err.message)
      }
    }
    reader.readAsArrayBuffer(file)
  }

  // Event listeners setup
  document.querySelector('.make-btn').addEventListener('click', () => {
    document.querySelector('.initial-buttons').style.display = 'none'
    document.querySelector('.make-form').style.display = 'block'
  })
  document.querySelector('.join-btn').addEventListener('click', () => {
    document.querySelector('.initial-buttons').style.display = 'none'
    document.querySelector('.join-form').style.display = 'block'
  })
  document.querySelector('.load-btn').addEventListener('click', () => {
    document.querySelector('.initial-buttons').style.display = 'none'
    document.querySelector('.load-form').style.display = 'block'
  })
  document.querySelector('.make-network-btn').addEventListener('click', make_network)
  document.querySelector('.join-with-invite-btn').addEventListener('click', join_network)
  document.querySelector('.load-mnemonic-btn').addEventListener('click', load_from_mnemonic)
  document.querySelectorAll('nav button').forEach(btn => {
    btn.addEventListener('click', () => show_view(btn.dataset.view))
  })
  document.addEventListener('click', (event) => {
    const target = event.target
    if (target.classList.contains('subscribe-btn')) handle_subscribe(target.dataset.key)
    if (target.classList.contains('unsubscribe-btn')) handle_unsubscribe(target.dataset.key)
    if (target.classList.contains('back-btn')) {
      document.querySelectorAll('.make-form, .join-form, .load-form').forEach(form => form.style.display = 'none')
      document.querySelector('.initial-buttons').style.display = 'block'
    }
    if (target.classList.contains('copy-address-btn')) {
      const text = document.querySelector('.blog-address-input').value
      if (navigator.clipboard) navigator.clipboard.writeText(text)
      else { const el = document.createElement('textarea'); el.value = text; document.body.appendChild(el); el.select(); document.execCommand('copy'); document.body.removeChild(el) }
    }
    if (target.classList.contains('copy-invite-btn')) {
      const invite_input = document.querySelector('.invite-code-display')
      const code_to_copy = invite_input ? invite_input.value : ''
      if (navigator.clipboard) navigator.clipboard.writeText(code_to_copy)
      else { const el = document.createElement('textarea'); el.value = code_to_copy; document.body.appendChild(el); el.select(); document.execCommand('copy'); document.body.removeChild(el) }
      const orig = target.textContent
      target.textContent = 'Copied!'
      setTimeout(() => { target.textContent = orig }, 2000)
    }
    if (target.classList.contains('relay-add-btn')) {
      const relay_input = document.querySelector('.relay-input')
      const relay_url = relay_input.value.trim()
      if (!relay_url) return alert('Please enter a relay URL')
      add_relay(relay_url)
      relay_input.value = ''
      render_view('config')
    }
    if (target.classList.contains('relay-default-btn')) {
      set_default_relay(target.dataset.relay)
      render_view('config')
    }
    if (target.classList.contains('relay-remove-btn')) {
      remove_relay(target.dataset.relay)
      render_view('config')
    }
    if (target.classList.contains('create-invite-btn')) handle_create_invite()
    if (target.classList.contains('manual-subscribe-btn')) handle_manual_subscribe()
    if (target.classList.contains('remove-device-btn')) handle_remove_device(target)
    if (event.target.classList.contains('reset-data-btn') || event.target.classList.contains('reset-all-btn')) handle_reset_all_data()
    if (event.target.classList.contains('upload-avatar-btn')) handle_upload_avatar()
    if (target.classList.contains('show-raw-data-btn')) handle_raw_data('toggle')
    const classList = Array.from(target.classList)
    const rawBtnClass = classList.find(c => c.startsWith('raw-') && c.endsWith('-btn'))
    if (rawBtnClass) {
      const structure_name = rawBtnClass.replace('raw-', '').replace('-btn', '')
      handle_raw_data('show', structure_name)
    }
  })

  // Auto-join if we have a username
  if (username) make_network()
}

// Call webapp_ui with the identity_api parameter provided by datashell
webapp_ui(vault)
