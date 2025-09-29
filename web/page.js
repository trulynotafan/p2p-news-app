const { start: start_browser_peer } = require('../src/node_modules/web-peer')
const blog_helper = require('../src/node_modules/helpers/blog-helpers')

let store
let username = localStorage.getItem('username') || ''
let current_view
let is_ready = false
let is_joining = false
let swarm = null

// Basic HTML structure
document.body.innerHTML = `
  <div class="app">
    <div class="login" style="display: ${username ? 'none' : 'block'}">
      <h3>P2P News App</h3>
      
      <!-- Make form - only shows username -->
      <div class="make-form" style="display: none; margin-top: 10px;">
        <button class="back-btn" style="margin-bottom: 5px;">← Back</button><br>
        <input class="username-input" value="${username}" placeholder="Your Name">
        <button class="make-network-btn">Create Blog</button>
      </div>
      
      <!-- Join form - only shows invite code -->
      <div class="join-form" style="display: none; margin-top: 10px;">
        <button class="back-btn" style="margin-bottom: 5px;">← Back</button><br>
        <input class="invite-code-input" placeholder="Paste invite code here" style="width: 300px;">
        <button class="join-with-invite-btn">Join with Invite</button>
      </div>
      
      <!-- Load form - only shows mnemonic -->
      <div class="load-form" style="display: none; margin-top: 10px;">
        <button class="back-btn" style="margin-bottom: 5px;">← Back</button><br>
        <input class="mnemonic-input" placeholder="Enter mnemonic phrase" style="width: 300px;">
        <button class="load-mnemonic-btn">Load from Mnemonic</button>
      </div>
      
      <!-- Initial buttons -->
      <div class="initial-buttons">
        <button class="make-btn">Seed</button>
        <button class="join-btn">Pair</button>
        <button class="load-btn">Load</button>
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
    status_el.textContent = '🟡 Please wait, joining the swarm...'

    function handle_swarm_connection () {
      is_joining = false
      status_el.textContent = `🟢 Connected as ${username} (${swarm.connections.size} peers)`
      if (current_view) render_view(current_view)
    }

    function handle_swarm_disconnection () {
      status_el.textContent = `🟢 Connected as ${username} (${swarm.connections.size} peers)`
    }

    swarm.on('connection', handle_swarm_connection)
    swarm.on('disconnection', handle_swarm_disconnection)

    function handle_connection_timeout () {
      is_joining = false
      if (swarm.connections.size > 0) {
        status_el.textContent = `🟢 Connected as ${username} (${swarm.connections.size} peers)`
      } else {
        status_el.textContent = `🟢 Joined swarm as ${username} (waiting for peers...)`
      }
      if (current_view) render_view(current_view)
    }

    setTimeout(handle_connection_timeout, 2000)
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

    const { store: _store, swarm: _swarm } = await start_browser_peer({
      name: username,
      get_blog_key: () => blog_helper.get_autobase_key(),
      get_blog_autobase: () => blog_helper.get_autobase(),
      get_metadata_store: () => blog_helper.get_metadata_store(),
      get_drive_store: () => blog_helper.get_drive_store(),
      get_profile_store: () => blog_helper.get_profile_store()
    })
    store = _store
    swarm = _swarm

    function handle_blog_update () {
      if (current_view) render_view(current_view)
    }

    blog_helper.on_update(handle_blog_update)

    setup_connection_status(swarm)

    await blog_helper.init_blog({ store_instance: store, username })
    drive = blog_helper.get_drive()

    // Set ready immediately after blog init, don't wait for first update
    is_ready = true
    is_joining = false

    show_view('news')
  } catch (err) {
    document.querySelector('.connection-status').textContent = `🔴 Error: ${err.message}`
  }
}

// Wait for blog username to be available using events
async function wait_for_blog_username () {
  console.log('Waiting for blog username...')

  // First check if username is already available
  const existing_username = await blog_helper.get_blog_username()
  if (existing_username) {
    console.log('Username already available:', existing_username)
    return existing_username
  }

  // Wait for update event that indicates blog data is available
  return new Promise((resolve) => {
    const handler = async () => {
      const username = await blog_helper.get_blog_username()
      if (username) {
        resolve(username)
      }
    }

    blog_helper.on_update(handler)
  })
}

// Join existing network with invite
async function join_network () {
  const invite_code = document.querySelector('.invite-code-input').value.trim()
  if (!invite_code) return alert('Please enter an invite code.')

  document.querySelector('.login').style.display = 'none'
  document.querySelector('.main').style.display = 'block'

  try {
    document.querySelector('.connection-status').textContent = 'Connecting...'
    is_joining = true

    const { store: _store, swarm: _swarm } = await start_browser_peer({
      name: 'joining-user',
      invite_code: invite_code,
      get_blog_key: () => blog_helper.get_autobase_key(),
      get_blog_autobase: () => blog_helper.get_autobase(),
      get_metadata_store: () => blog_helper.get_metadata_store(),
      get_drive_store: () => blog_helper.get_drive_store(),
      get_profile_store: () => blog_helper.get_profile_store()
    })
    store = _store
    swarm = _swarm

    blog_helper.on_update(() => { if (current_view) render_view(current_view) })
    setup_connection_status(swarm)

    // Wait for blog to be initialized and get username from paired device
    const paired_username = await wait_for_blog_username()
    if (paired_username) {
      username = paired_username
      localStorage.setItem('username', username)
      console.log('Username updated to:', username)
      // Update the connection status to show the correct username
      setup_connection_status(swarm)
    }

    is_ready = true
    is_joining = false
    show_view('news')
  } catch (err) {
    document.querySelector('.connection-status').textContent = `🔴 Error: ${err.message}`
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

// Render function
async function render_view (view, ...args) {
  const view_el = document.querySelector('.view')

  if (is_joining) {
    view_el.innerHTML = '<p>Joining, please wait...</p>'
    return
  }

  if (!is_ready && view !== 'explore') return // Explore works without blog init
  view_el.innerHTML = 'Loading...'

  const renderers = {
    news: async () => {
      const peer_blogs = await blog_helper.get_peer_blogs()

      if (peer_blogs.size === 0) {
        view_el.innerHTML = '<p>No posts from subscribed peers yet. Go to the explore tab to find peers.</p>'
        return
      }

      let html = ''
      for (const [key, blog] of peer_blogs) {
        const profile = await blog_helper.get_profile(key)
        const display_name = profile ? profile.name : blog.username
        
        html += `<h2>${escape_html(display_name)}'s Blog (${escape_html(blog.title)})</h2>`
        if (blog.posts.length === 0) {
          html += '<p>No posts from this peer yet.</p>'
        } else {
          for (const post of blog.posts) {
            html += `
              <div class="post">
                <h3>${escape_html(post.title)}</h3>
                <p>${escape_html(post.content)}</p>
                <span>Posted by ${escape_html(display_name)} on: ${new Date(post.created).toLocaleString()}</span>
              </div>
            `
          }
        }
      }
      view_el.innerHTML = html
    },

    blog: async () => {
      const profile = await blog_helper.get_profile()
      const display_name = profile ? profile.name : username
      
      view_el.innerHTML = `<h3>${escape_html(display_name)}'s Blog</h3>`
      const posts = await blog_helper.get_my_posts()
      if (posts.length === 0) return view_el.innerHTML += '<p>You have not written any posts yet. Go to New Post to create one.</p>'
      for (const post of posts) {
        view_el.innerHTML += `
          <div class="post">
            <h4>${escape_html(post.title)}</h4>
            <p>${escape_html(post.content)}</p>
            <small>Posted on: ${format_date(post.created)}</small>
          </div>
        `
      }
    },

    explore: async () => {
      view_el.innerHTML = '<h3>Explore Peers</h3>'
      const discovered = blog_helper.get_discovered_blogs()
      const subscribed_blogs = await blog_helper.get_peer_blogs()
      const subscribed_keys = Array.from(subscribed_blogs.keys())
      const my_key = blog_helper.get_autobase_key()

      // Show discovered peers (not yet subscribed)
      if (discovered.size > 0) {
        view_el.innerHTML += '<h4>Discovered Peers</h4>'
        for (const [key, peer] of discovered) {
          if (key === my_key) continue // Skip own blog
          const profile = await blog_helper.get_profile(key)
          const display_name = profile ? profile.name : peer.username
          
          view_el.innerHTML += `
            <div>
              <h5>${escape_html(display_name)}'s Blog (${escape_html(peer.title)})</h5>
              <p><code>${key}</code></p>
              <button class="subscribe-btn" data-key="${key}">Subscribe</button>
            </div>
            <hr>
          `
        }
      }

      // Show subscribed peers
      if (subscribed_blogs.size > 0) {
        view_el.innerHTML += '<h4>Subscribed Peers</h4>'
        for (const [key, blog] of subscribed_blogs) {
          if (key === my_key) continue // Skip own blog
          const profile = await blog_helper.get_profile(key)
          const display_name = profile ? profile.name : blog.username
          
          view_el.innerHTML += `
            <div>
              <h5>${escape_html(display_name)}'s Blog (${escape_html(blog.title)})</h5>
              <p><code>${key}</code></p>
              <button class="unsubscribe-btn" data-key="${key}">Unsubscribe</button>
            </div>
            <hr>
          `
        }
      }

      // Show message if no peers at all
      if (discovered.size === 0 && subscribed_blogs.size === 0) {
        view_el.innerHTML += '<p>No peers found yet. Wait for peers to be discovered.</p>'
      }
    },

    post: () => {
      view_el.innerHTML = `
        <h3>Create New Post</h3>
        <input class="post-title" placeholder="Title">
        <textarea class="post-content" placeholder="Content"></textarea>
        <button class="publish-btn">Publish</button>
      `
      const publish_btn = view_el.querySelector('.publish-btn')
      publish_btn.addEventListener('click', handle_publish)
    },

    config: async () => {
      const my_key = blog_helper.get_autobase_key()
      const profile = await blog_helper.get_profile()
      const avatar_content = await blog_helper.get_avatar_content()
      
      view_el.innerHTML = `
        <h3>Configuration</h3>
        <div>
          <h4>My Profile</h4>
          <p>Your current profile information:</p>
          <div style="background: #f5f5f5; padding: 10px; border-radius: 5px; margin: 10px 0;">
            <p><strong>Name:</strong> ${profile ? escape_html(profile.name) : 'Loading...'}</p>
            <p><strong>Avatar:</strong> ${avatar_content ? avatar_content : 'Loading...'}</p>
          </div>
        </div>
        <hr>
        <div>
          <h4>My Blog Address</h4>
          <p>Share this address with others so they can subscribe to your blog.</p>
          <input class="blog-address-input" readonly value="${my_key}" size="70">
          <button class="copy-address-btn">Copy</button>
        </div>
        <hr>
        <div>
          <h4>Create Invite</h4>
          <p>Create an invite to share write access to your blog.</p>
          <button class="create-invite-btn">Create Invite</button>
          <div class="invite-result" style="margin-top: 10px;"></div>
        </div>
        <hr>
        <div>
          <h4>Manual Subscribe</h4>
          <p>Subscribe to a blog by its address.</p>
          <input class="manual-key-input" placeholder="Blog Address" size="70">
          <button class="manual-subscribe-btn">Subscribe</button>
        </div>
        <hr>
        <div>
          <h4>Show Raw Data</h4>
          <button class="show-raw-data-btn">Show Raw Data</button>
          <div class="raw-data-options" style="display: none; margin-top: 10px;">
            <button class="raw-metadata-btn">Metadata Autobase</button>
            <button class="raw-posts-btn">Posts Autodrive</button>
            <button class="raw-profile-btn">Profile Autodrive</button>
          </div>
          <pre class="raw-data-display" style="display: none; background: #f0f0f0; padding: 10px; margin-top: 10px; white-space: pre-wrap; max-height: 300px; overflow-y: auto;"></pre>
        </div>
        <hr>
        <div>
          <h4>Reset</h4>
          <button class="reset-data-btn">Delete All My Data</button>
        </div>
      `
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
    await blog_helper.create_post(title, content)
    show_view('blog')
  } catch (err) {
    alert('Publish error: ' + err.message)
  }
}

async function handle_subscribe (key) {
  await blog_helper.subscribe(key)
  show_view('explore')
}

async function handle_unsubscribe (key) {
  await blog_helper.unsubscribe(key)
  show_view('explore')
}

async function handle_create_invite () {
  try {
    const invite_code = await blog_helper.create_invite(swarm)
    const invite_result = document.querySelector('.invite-result')

    invite_result.innerHTML = `
      <p>Invite created! Share this code:</p>
      <input class="invite-code-display" readonly value="${invite_code}" style="width: 400px;">
      <button class="copy-invite-btn">Copy</button>
      <p><small>Keep this page open while others join.</small></p>
    `

    // Add event listener for the copy button
    const copy_btn = invite_result.querySelector('.copy-invite-btn')
    copy_btn.addEventListener('click', () => {
      navigator.clipboard.writeText(invite_code)
    })
  } catch (err) {
    alert('Error creating invite: ' + err.message)
  }
}

async function handle_manual_subscribe () {
  const key = document.querySelector('.manual-key-input').value.trim()
  if (!key) return alert('Please enter a blog address.')

  const my_key = blog_helper.get_autobase_key()
  if (key === my_key) return alert("You can't subscribe to yourself.") // Prevent self-subscription

  const success = await blog_helper.subscribe(key)
  if (success) {
    alert('Successfully subscribed!')
    show_view('news')
  } else {
    alert('Failed to subscribe. The key may be invalid or the peer is offline.')
  }
}

// Reset all data function
async function handle_reset_all_data () {
  if (!confirm('Delete all data?')) return

  try {
    localStorage.clear()

    const databases = await window.indexedDB.databases()
    for (const db of databases) {
      if (db.name && (db.name.includes('blogs-') || db.name.includes('random-access-web'))) {
        window.indexedDB.deleteDatabase(db.name) // Clear app storage
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

    function handle_page_reload () {
      window.location.reload()
    }

    setTimeout(handle_page_reload, 1000)
  } catch (err) {
    alert('Reset error: ' + err.message)
  }
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
  blog_helper.get_raw_data(type).then(data => display.textContent = data).catch(err => display.textContent = 'Error: ' + err.message)
}

// Event listeners
function handle_make_form_display () {
  document.querySelector('.initial-buttons').style.display = 'none'
  document.querySelector('.make-form').style.display = 'block'
}

function handle_join_form_display () {
  document.querySelector('.initial-buttons').style.display = 'none'
  document.querySelector('.join-form').style.display = 'block'
}

function handle_load_form_display () {
  document.querySelector('.initial-buttons').style.display = 'none'
  document.querySelector('.load-form').style.display = 'block'
}

function handle_nav_button_click (btn) {
  return () => show_view(btn.dataset.view)
}

function setup_nav_button_listeners (btn) {
  btn.addEventListener('click', handle_nav_button_click(btn))
}

// Event delegation for dynamic content
function handle_document_click (event) {
  const target = event.target

  // Handle subscribe buttons
  if (target.classList.contains('subscribe-btn')) {
    const key = target.dataset.key
    handle_subscribe(key)
  }

  // Handle unsubscribe buttons
  if (target.classList.contains('unsubscribe-btn')) {
    const key = target.dataset.key
    handle_unsubscribe(key)
  }

  // Handle back buttons
  if (target.classList.contains('back-btn')) {
    document.querySelectorAll('.make-form, .join-form, .load-form').forEach(form => form.style.display = 'none')
    document.querySelector('.initial-buttons').style.display = 'block'
  }

  // Handle config buttons
  if (target.classList.contains('copy-address-btn')) {
    const address_input = document.querySelector('.blog-address-input')
    navigator.clipboard.writeText(address_input.value)
  }

  if (target.classList.contains('create-invite-btn')) {
    handle_create_invite()
  }

  if (target.classList.contains('manual-subscribe-btn')) {
    handle_manual_subscribe()
  }

  if (target.classList.contains('reset-data-btn')) {
    handle_reset_all_data()
  }

  // Handle raw data buttons
  if (target.classList.contains('show-raw-data-btn')) handle_raw_data('toggle')
  if (target.classList.contains('raw-metadata-btn')) handle_raw_data('show', 'metadata')
  if (target.classList.contains('raw-posts-btn')) handle_raw_data('show', 'posts')
  if (target.classList.contains('raw-profile-btn')) handle_raw_data('show', 'profile')
}

// Setup event listeners
document.querySelector('.make-btn').addEventListener('click', handle_make_form_display)
document.querySelector('.join-btn').addEventListener('click', handle_join_form_display)
document.querySelector('.load-btn').addEventListener('click', handle_load_form_display)
document.querySelector('.make-network-btn').addEventListener('click', make_network)
document.querySelector('.join-with-invite-btn').addEventListener('click', join_network)
document.querySelector('.load-mnemonic-btn').addEventListener('click', load_from_mnemonic)
document.querySelectorAll('nav button').forEach(setup_nav_button_listeners)
document.addEventListener('click', handle_document_click)

// auto-join if we have a username
if (username) make_network()
