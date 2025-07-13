const { start: start_browser_peer } = require('../src/node_modules/web-peer')
const blog_helper = require('../src/node_modules/helpers/blog-helpers')
const b4a = require('b4a')

let username = localStorage.getItem('username') || ''
let current_view; let connection_status = 'disconnected'; let store; let blog_core; let update_interval

// basic html structure
document.body.innerHTML = `
  <div id="app">
    <div id="login" style="display: ${username ? 'none' : 'block'}">
      <h3>P2P Blog</h3>
      <input id="username" value="${username}" placeholder="Your Name">
      <button id="join_btn">Join</button>
    </div>
    <div id="main" style="display: ${username ? 'block' : 'none'}">
      <div>Status: <span id="connection_status">Disconnected</span></div>
      <nav>
        <button data-view="news">News</button>
        <button data-view="blog">Blog</button>
        <button data-view="explore">Explore</button>
        <button data-view="post">Post</button>
        <button data-view="config">Config</button>
      </nav>
      <style>
        nav button.active { background-color: #007bff; color: white; }
      </style>
      <div id="view"></div>
    </div>
  </div>
`

// utility functions
const format_date = timestamp => new Date(timestamp).toLocaleString()

// core functionality
async function join_network () {
  const user = document.getElementById('username').value.trim() || username
  if (!user) return alert('Enter your name')
  
  localStorage.setItem('username', user)
  username = user
  
  document.getElementById('login').style.display = 'none'
  document.getElementById('main').style.display = 'block'
  
  try {
    document.getElementById('connection_status').textContent = 'Connecting...'
    connection_status = 'connecting'
    
    const relays = JSON.parse(localStorage.getItem('relays') || '[]')
    const custom_relay = localStorage.getItem('custom_relay') || (relays.length > 0 ? relays[0] : null)
    
    const connectionPromise = start_browser_peer({ name: username, relay: custom_relay })
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Connection timeout')), 10000)
    )
    
    const result = await Promise.race([connectionPromise, timeoutPromise])
    store = result.store
    blog_core = result.blog_core
    await blog_helper.init_blog(store, username)
    
    if (result.swarm) {
      connection_status = 'connected'
      const current_relay = custom_relay || (location.hostname === 'localhost' || location.hostname.startsWith('192.') || location.hostname.startsWith('10.') ? 'ws://localhost:8080' : 'wss://p2p-relay-production.up.railway.app')
      document.getElementById('connection_status').textContent = `🟢 ${username} via ${current_relay}`
    } else {
      connection_status = 'error'
      const current_relay = custom_relay || (location.hostname === 'localhost' || location.hostname.startsWith('192.') || location.hostname.startsWith('10.') ? 'ws://localhost:8080' : 'wss://p2p-relay-production.up.railway.app')
      document.getElementById('connection_status').textContent = `🔴 ${username} - Offline Mode (tried: ${current_relay})`
    }
    
    store.on('core', async (core) => {
      const key = b4a.toString(core.key, 'hex')
      const manual_peers = JSON.parse(localStorage.getItem('manual_subscribed_peers') || '[]')
      
      // if its manually saved, subscribe to it
      if (manual_peers.includes(key)) {
        // give it some time to fully init before subscribing
        setTimeout(() => {
          blog_helper.subscribe(key).then(() => {
            // remove from manual peers after subsribing so next time reconnection handles it 
            const updated_manual_peers = manual_peers.filter(p => p !== key)
            localStorage.setItem('manual_subscribed_peers', JSON.stringify(updated_manual_peers))
            if (current_view === 'explore') render_view('explore')
          })
        }, 2000)
      } else {
        // let blog helpers handle normal peer discovery
        await blog_helper.handle_new_core(core)
      }
      
      if (current_view === 'explore') render_view('explore')
    })
    
    store.on('blog-discovered', async () => {
      if (current_view === 'explore') render_view('explore')
    })
    
    blog_helper.on_update(() => {
      if (['news', 'explore'].includes(current_view)) render_view(current_view)
    })
    
    show_view('news')
  } catch (err) {
    connection_status = 'error'
    document.getElementById('connection_status').textContent = 'Connection Error'
    show_view('news')
  }
}

// view system
function show_view (name) {
  if (!store && connection_status !== 'error' && !['blog', 'post'].includes(name)) {
    alert('Please connect first')
    return
  }

  if (update_interval) {
    clearInterval(update_interval)
    update_interval = null
  }

  current_view = name
  document.querySelectorAll('nav button').forEach(btn => 
    btn.classList.toggle('active', btn.dataset.view === name)
  )
  render_view(name)
  
  if (name === 'explore') {
    // Only refresh when new peers are discovered no need for timer
  }
}

// render function
function render_view (view) {
  const renderers = {
    news: async () => {
      if (!blog_core) return '<h3>News Feed</h3><p>No data yet</p>'
      
      try {
        const peer_blogs = await blog_helper.get_peer_blogs()
        
        const posts = Array.from(peer_blogs.entries()).flatMap(([key, peer]) => 
          (peer.posts || []).map(p => ({ ...p, peer_key: key, peer_name: peer.username || 'Unknown' }))
        ).sort((a, b) => b.created - a.created)
        
        let content = `
          <h3>News Feed (${posts.length} posts)</h3>
          ${posts.map(p => `
            <div>
              <h4>${p.title}</h4>
              <small>${p.peer_name} - ${format_date(p.created)}</small>
              <p>${p.content}</p>
              <hr>
            </div>
          `).join('') || '<p>No posts yet</p>'}
        `
        
        if (connection_status === 'error') {
          content += `
            <hr>
            <div style="background: #ffe6e6; padding: 10px; border-radius: 5px; margin-top: 20px;">
              <p><strong>Connection Error:</strong> Please check your relay connection</p>
              <button onclick="location.reload()">Retry</button>
              <button onclick="reset_relay_and_reload()">Reset Relay & Retry</button>
            </div>
          `
        }
        
        return content
      } catch (err) {
        console.error('Error loading news:', err)
        return '<h3>News Feed</h3><p>Error loading posts</p>'
      }
    },
    
    blog: async () => {
      if (!blog_core) return '<h3>My Blog</h3><p>No data yet</p>'
      
      const posts = await blog_helper.get_my_posts()
      const sorted_posts = posts
        .sort((a, b) => b.created - a.created)
        .map(p => `
          <div>
            <h4>${p.title}</h4>
            <small>${format_date(p.created)}</small>
            <p>${p.content}</p>
            <hr>
          </div>
        `).join('')
      return sorted_posts || '<p>No posts yet</p>'
    },
    
    explore: async () => {
      if (!blog_core) return '<h3>Explore</h3><p>No data yet</p>'
      
      const my_key = b4a.toString(blog_helper.get_my_core_key(), 'hex')
      const discovered = await blog_helper.get_discovered_blogs()
      const subscribed = await blog_helper.get_peer_blogs()
      const discovered_relays = Array.from(window.discovered_relays || []).filter(r => !r.includes('localhost'))
      
      const blogs = Array.from(discovered.entries())
        .filter(([key, data]) => key !== my_key)
        .map(([key, data]) => {
          const is_subscribed = subscribed.has(key)
          return `
            <div>
              <b>${data.title}</b>
              <button onclick="${is_subscribed ? 'unsub' : 'sub'}('${key}')">
                ${is_subscribed ? 'Unsubscribe' : 'Subscribe'}
              </button>
              <hr>
            </div>
          `
        }).join('')
      
      const relay_section = discovered_relays.length > 0 ? 
        '<h4>Discovered Relays</h4>' + discovered_relays.map(r => 
          `<div><b>${r}</b><button onclick="add_relay('${r}')">Add Relay</button><hr></div>`
        ).join('') : ''
      
      return `
        <h3>Explore</h3>
        <button onclick="show_my_address()">Show My Blog Address</button>
        <div id="my_address" style="display:none"><b>${my_key}</b></div>
        <hr>
        <h4>Manual Subscribe</h4>
        <input id="manual_key" placeholder="Enter blog address (hex key)">
        <button onclick="manual_subscribe()">Subscribe</button>
        <hr>
        ${blogs + relay_section || '<p>No blogs discovered</p>'}
      `
    },
    
    post: () => `
      <h3>Create Post</h3>
      <input id="post_title" placeholder="Title"><br>
      <textarea id="post_content" rows="5" placeholder="Content"></textarea><br>
      <button onclick="publish()">Publish</button>
    `,
    
    config: () => {
      const relays = JSON.parse(localStorage.getItem('relays') || '[]')
      const current_relay = localStorage.getItem('custom_relay') || (location.hostname === 'localhost' || location.hostname.startsWith('192.') || location.hostname.startsWith('10.') ? 'ws://localhost:8080' : 'wss://p2p-relay-production.up.railway.app')
      return `
        <h3>Config</h3>
        <p>Username: ${username}</p>
        <p>Status: ${connection_status}</p>
        <hr>
        <h4>Relay Settings</h4>
        <p>Current: ${current_relay}</p>
        <p>Saved Relays: ${relays.length}</p>
        ${relays.map(r => `<div>• ${r} <button onclick="connect_to_relay('${r}')">Connect</button> <button onclick="delete_relay('${r}')">Delete</button></div>`).join('')}
        <input id="custom_relay" placeholder="Custom relay URL (e.g., ws://localhost:8080)" value="">
        <button onclick="set_custom_relay()">Add Relay</button>
        <button onclick="reset_relay()">Reset to Default</button>
        <hr>
        <h4>Reset Data</h4>
        <p>Delete all local data and start fresh</p>
        <button onclick="reset_all_data()" style="background: red; color: white;">
          Reset All Data
        </button>
      `
    }
  }
  
  const renderer = renderers[view]
  if (renderer) {
    if (renderer.constructor.name === 'AsyncFunction') {
      renderer().then(html => {
        document.getElementById('view').innerHTML = html
      })
    } else {
      document.getElementById('view').innerHTML = renderer()
    }
  } else {
    document.getElementById('view').innerHTML = '<p>View not found</p>'
  }
}

// action handlers
window.publish = async () => {
  const title = document.getElementById('post_title').value.trim()
  const content = document.getElementById('post_content').value.trim()
  
  if (!title || !content) return alert('Enter title and content')
  
  if (await blog_helper.create_post(title, content)) {
    document.getElementById('post_title').value = ''
    document.getElementById('post_content').value = ''
    show_view('blog')
  }
}

window.sub = key => blog_helper.subscribe(key).then(() => show_view('explore'))
window.unsub = key => blog_helper.unsubscribe(key).then(() => show_view('explore'))

window.set_custom_relay = () => {
  const relay = document.getElementById('custom_relay').value.trim()
  if (!relay) {
    alert('Enter a relay URL')
    return
  }
  
  if (!relay.startsWith('ws://') && !relay.startsWith('wss://')) {
    alert('Relay URL must start with ws:// or wss://')
    return
  }
  
  const relays = JSON.parse(localStorage.getItem('relays') || '[]')
  if (!relays.includes(relay)) {
    relays.push(relay)
    localStorage.setItem('relays', JSON.stringify(relays))
  }
  document.getElementById('custom_relay').value = ''
  if (current_view === 'config') render_view('config')
}

window.reset_relay = () => {
  localStorage.removeItem('custom_relay')
  localStorage.removeItem('relays')
  document.getElementById('custom_relay').value = ''
  alert('Relay reset to default. Reconnect to apply changes.')
}

window.reset_relay_and_reload = () => {
  localStorage.removeItem('custom_relay')
  localStorage.removeItem('relays')
  location.reload()
}

window.add_relay = (relay) => {
  const relays = JSON.parse(localStorage.getItem('relays') || '[]')
  if (!relays.includes(relay)) {
    relays.push(relay)
    localStorage.setItem('relays', JSON.stringify(relays))
    alert('Relay added')
  }
}

window.connect_to_relay = (relay) => {
  localStorage.setItem('custom_relay', relay)
  location.reload()
}

window.delete_relay = (relay) => {
  const relays = JSON.parse(localStorage.getItem('relays') || '[]')
  const filtered = relays.filter(r => r !== relay)
  localStorage.setItem('relays', JSON.stringify(filtered))
  if (current_view === 'config') render_view('config')
}

window.show_my_address = () => {
  document.getElementById('my_address').style.display = 'block'
}

window.manual_subscribe = () => {
  const key = document.getElementById('manual_key').value.trim()
  if (!key) return alert('Enter a blog address')
  
  const my_key = b4a.toString(blog_helper.get_my_core_key(), 'hex')
  if (key === my_key) {
    alert('You\'re subscribing to yourself, duh')
    return
  }
  
  // save to localStorage even if peer is offline
  const manual_peers = JSON.parse(localStorage.getItem('manual_subscribed_peers') || '[]')
  if (!manual_peers.includes(key)) {
    manual_peers.push(key)
    localStorage.setItem('manual_subscribed_peers', JSON.stringify(manual_peers))
  }
  
  blog_helper.subscribe(key).then((success) => {
    document.getElementById('manual_key').value = ''
    const message = `Blog address ${key} added to local storage. You will subscribe to this peer when it comes online.`
    console.log(message)
    alert(message)
    show_view('explore')
  }).catch(() => {
    // even if subscribe fails (peer offline), we still saved the key so next time it comes online it will subscribe
    document.getElementById('manual_key').value = ''
    const message = `Blog address ${key} added to local storage. You will subscribe to this peer when it comes online.`
    console.log(message)
    alert(message)
    show_view('explore')
  })
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

// event listeners
document.getElementById('join_btn').addEventListener('click', join_network)
document.querySelectorAll('nav button').forEach(btn => 
  btn.addEventListener('click', () => show_view(btn.dataset.view))
)

// auto-join if we have a username
if (username) join_network()