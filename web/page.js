const { start: start_browser_peer } = require('../src/node_modules/web-peer')
const blog_helper = require('../src/node_modules/helpers/blog-helpers')
const b4a = require('b4a')

let store
let username = localStorage.getItem('username') || ''
let current_view
let is_ready = false
let is_joining = false
let swarm = null

// Basic HTML structure
document.body.innerHTML = `
  <div id="app">
    <div id="login" style="display: ${username ? 'none' : 'block'}">
      <h3>P2P News App</h3>
      <input id="username" value="${username}" placeholder="Your Name">
      <div>
        <button id="make_btn">Start</button>
      </div>
    </div>
    <div id="main" style="display: ${username ? 'block' : 'none'}">
      <div>Status: <span id="connection_status">Disconnected</span></div>
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
      <div id="view"></div>
    </div>
  </div>
`

// Utility functions
const format_date = timestamp => new Date(timestamp).toLocaleString()
const escape_html = str => str ? str.replace(/[&<>"']/g, tag => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[tag])) : ''

// Core functionality
async function make_network(relay_override) {
  const user = document.getElementById('username').value.trim() || username
  if (!user) return alert('Please enter your name to make.')

  localStorage.setItem('username', user)
  username = user

  document.getElementById('login').style.display = 'none'
  document.getElementById('main').style.display = 'block'

  try {
    document.getElementById('connection_status').textContent = 'Connecting to relay...'
    is_joining = true

    const options = { name: username }
    if (relay_override) options.relay = relay_override
    else if (localStorage.getItem('default_relay')) options.relay = localStorage.getItem('default_relay')
    const { store: _store, swarm: _swarm } = await start_browser_peer(options)
    store = _store
    swarm = _swarm

    blog_helper.on_update(() => {
      // Just re-render the current view when updates happen
      if (current_view) render_view(current_view)
    })

    if (swarm) {
      document.getElementById('connection_status').textContent = '🟡 Please wait, joining the swarm...'
      
      swarm.on('connection', () => {
        is_joining = false
        document.getElementById('connection_status').textContent = `🟢 Connected as ${username} (${swarm.connections.size} peers)`
        if (current_view) render_view(current_view)
      })
      swarm.on('disconnection', () => {
        document.getElementById('connection_status').textContent = `🟢 Connected as ${username} (${swarm.connections.size} peers)`
      })
      
      setTimeout(() => {
        is_joining = false
        if (swarm.connections.size > 0) {
          document.getElementById('connection_status').textContent = `🟢 Connected as ${username} (${swarm.connections.size} peers)`
        } else {
          document.getElementById('connection_status').textContent = `🟢 Joined swarm as ${username} (waiting for peers...)`
        }
        if (current_view) render_view(current_view)
      }, 2000)
    } else {
      is_joining = false
      document.getElementById('connection_status').textContent = '🟠 Offline mode (relay not available)'
    }

    await blog_helper.init_blog(store, username)
    drive = blog_helper.get_drive()
    
    // Set ready immediately after blog init, don't wait for first update
    is_ready = true
    is_joining = false

    show_view('news')
  } catch (err) {
    document.getElementById('connection_status').textContent = `🔴 Error: ${err.message}`
  }
}

// View system
function show_view (name) {
  current_view = name
  document.querySelectorAll('nav button').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.view === name)
  )
  render_view(name)
}

// Render function
async function render_view (view, ...args) {
  const view_el = document.getElementById('view')
  
  if (is_joining) {
    view_el.innerHTML = '<p>Joining, please wait...</p>'
    return
  }
  
  if (!is_ready && view !== 'explore') return;
  view_el.innerHTML = 'Loading...'

  const renderers = {
    news: async () => {
      const peer_blogs = await blog_helper.get_peer_blogs();

      if (peer_blogs.size === 0) {
        view_el.innerHTML = '<p>No posts from subscribed peers yet. Go to the explore tab to find peers.</p>';
        return;
      }

      let html = '';
      for (const [, blog] of peer_blogs) {
        html += `<h2>${escape_html(blog.title)}</h2>`;
        if (blog.posts.length === 0) {
          html += '<p>No posts from this peer yet.</p>';
        } else {
          for (const post of blog.posts) {
            html += `
              <div class="post">
                <h3>${escape_html(post.title)}</h3>
                <p>${escape_html(post.content)}</p>
                <span>Posted on: ${new Date(post.created).toLocaleString()}</span>
              </div>
            `;
          }
        }
      }
      view_el.innerHTML = html;
    },

    blog: async () => {
      view_el.innerHTML = '<h3>My Blog</h3>'
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
      const my_key = b4a.toString(blog_helper.get_my_core_key(), 'hex')

      // Show discovered peers (not yet subscribed)
      if (discovered.size > 0) {
        view_el.innerHTML += '<h4>Discovered Peers</h4>'
        for (const [key, peer] of discovered) {
          if (key === my_key) continue
          view_el.innerHTML += `
            <div>
              <h5>${escape_html(peer.username)}'s Blog (${escape_html(peer.title)})</h5>
              <p><code>${key}</code></p>
              <button onclick="window.sub('${key}')">Subscribe</button>
            </div>
            <hr>
          `
        }
      }

      // Show subscribed peers
      if (subscribed_blogs.size > 0) {
        view_el.innerHTML += '<h4>Subscribed Peers</h4>'
        for (const [key, blog] of subscribed_blogs) {
          if (key === my_key) continue
          view_el.innerHTML += `
            <div>
              <h5>${escape_html(blog.username)}'s Blog (${escape_html(blog.title)})</h5>
              <p><code>${key}</code></p>
              <button onclick="window.unsub('${key}')">Unsubscribe</button>
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
        <input id="post_title" placeholder="Title">
        <textarea id="post_content" placeholder="Content"></textarea>
        <button id="publish_btn">Publish</button>
      `
      document.getElementById('publish_btn').addEventListener('click', window.publish)
    },

    config: () => {
      const my_key = b4a.toString(blog_helper.get_my_core_key(), 'hex')
      const relays = JSON.parse(localStorage.getItem('custom_relays') || '[]')
      const default_relay = localStorage.getItem('default_relay')
      
      let relay_html = ''
      relays.forEach(relay => {
        relay_html += `
          <div>
            <code>${relay}</code>
            <button onclick="window.connect_relay('${relay}')">Connect</button>
            <button onclick="window.remove_relay('${relay}')">Remove</button>
          </div>
        `
      })
      
      view_el.innerHTML = `
        <h3>Configuration</h3>
        <div>
          <h4>My Blog Address</h4>
          <p>Share this address with others so they can subscribe to your blog.</p>
          <input readonly value="${my_key}" size="70">
          <button onclick="navigator.clipboard.writeText('${my_key}')">Copy</button>
        </div>
        <hr>
        <div>
          <h4>Relay Management</h4>
          <p>Current: ${default_relay || 'Default'}</p>
          <input id="relay_input" placeholder="wss://your-relay.com or ws://localhost:8080" size="50">
          <button onclick="window.add_relay()">Add Relay</button>
          <button onclick="window.reset_default_relay()">Use Default</button>
          ${relay_html}
        </div>
        <hr>
        <div>
          <h4>Manual Subscribe</h4>
          <p>Subscribe to a blog by its address.</p>
          <input id="manual_key" placeholder="Blog Address" size="70">
          <button onclick="window.manual_subscribe()">Subscribe</button>
        </div>
        <hr>
        <div>
          <h4>Reset</h4>
          <button onclick="window.reset_all_data()">Delete All My Data</button>
        </div>
      `
    }
  }

  if (renderers[view]) await renderers[view]()
  else view_el.innerHTML = `View '${view}' not found.`
}

// Action handlers
window.publish = async () => {
  const title = document.getElementById('post_title').value
  const content = document.getElementById('post_content').value
  if (!title || !content) return alert('Title and content are required.')

  try {
    await blog_helper.create_post(title, content)
    show_view('blog')
  } catch (err) {
    alert('Publish error: ' + err.message)
  }
}

window.sub = async (key) => {
  await blog_helper.subscribe(key)
  show_view('explore')
}

window.unsub = async (key) => {
  await blog_helper.unsubscribe(key)
  show_view('explore')
}

window.manual_subscribe = async () => {
  const key = document.getElementById('manual_key').value.trim()
  if (!key) return alert('Please enter a blog address.')

  const my_key = b4a.toString(blog_helper.get_my_core_key(), 'hex')
  if (key === my_key) return alert("You can't subscribe to yourself.")

  const success = await blog_helper.subscribe(key)
  if (success) {
    alert('Successfully subscribed!')
    show_view('news')
  } else {
    alert('Failed to subscribe. The key may be invalid or the peer is offline.')
  }
}

// Relay management functions
window.add_relay = () => {
  const relay = document.getElementById('relay_input').value.trim()
  if (!relay) return alert('Enter relay URL')
  if (!relay.startsWith('ws://') && !relay.startsWith('wss://')) return alert('URL must start with ws:// or wss://')
  
  const relays = JSON.parse(localStorage.getItem('custom_relays') || '[]')
  if (!relays.includes(relay)) {
    relays.push(relay)
    localStorage.setItem('custom_relays', JSON.stringify(relays))
  }
  show_view('config')
}

window.connect_relay = (relay) => {
  localStorage.setItem('default_relay', relay)
  window.location.reload()
}

window.remove_relay = (relay) => {
  const relays = JSON.parse(localStorage.getItem('custom_relays') || '[]').filter(r => r !== relay)
  localStorage.setItem('custom_relays', JSON.stringify(relays))
  if (localStorage.getItem('default_relay') === relay) localStorage.removeItem('default_relay')
  show_view('config')
}

window.reset_default_relay = () => {
  localStorage.removeItem('default_relay')
  window.location.reload()
}

// Reset all data function
window.reset_all_data = async () => {
  if (!confirm('Delete all data?')) return
  
  try {
    localStorage.clear()
    
    const databases = await window.indexedDB.databases()
    for (const db of databases) {
      if (db.name && (db.name.includes('blogs-') || db.name.includes('random-access-web'))) {
        window.indexedDB.deleteDatabase(db.name)
      }
    }
    
    if (window.requestFileSystem || window.webkitRequestFileSystem) {
      const requestFileSystem = window.requestFileSystem || window.webkitRequestFileSystem
      await new Promise((resolve, reject) => {
        requestFileSystem(window.PERSISTENT, 1024 * 1024, fs => {
          fs.root.createReader().readEntries(entries => {
            if (!entries.length) return resolve()
            let completed = 0
            entries.forEach(entry => {
              const handler = () => {
                completed++
                if (completed === entries.length) resolve()
              }
              entry.isFile ? entry.remove(handler, handler) : entry.removeRecursively(handler, handler)
            })
          }, reject)
        }, reject)
      })
    }
    
    if (store) {
      try { await store.close() } catch (err) {}
    }
    
    setTimeout(() => window.location.reload(), 1000)
  } catch (err) {
    alert('Reset error: ' + err.message)
  }
}

// Event listeners
document.getElementById('make_btn').addEventListener('click', make_network)
document.querySelectorAll('nav button').forEach(btn =>
  btn.addEventListener('click', () => show_view(btn.dataset.view))
)

// auto-join if we have a username
if (username) make_network()