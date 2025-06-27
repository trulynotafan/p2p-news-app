const { start: start_browser_peer, reset: reset_peer_state } = require('../src/node_modules/web-peer')
const blog_helper = require('../src/node_modules/helpers/blog-helpers')
const b4a = require('b4a')

// basic state
const state = {
  username: localStorage.getItem('username') || '',
  custom_relay: localStorage.getItem('custom_relay'),
  current_view: null,
  connection_status: 'disconnected',
  update_interval: null,
  store: null,
  blog_core: null
}

// basic html structure
document.body.innerHTML = `
  <div id="app">
    <div id="login" style="display: ${state.username ? 'none' : 'block'}">
      <h3>P2P Blog</h3>
      <input id="username" value="${state.username}" placeholder="Your Name">
      <button id="join_btn">Join</button>
    </div>
    <div id="main" style="display: ${state.username ? 'block' : 'none'}">
      <div id="status">Status: <span id="connection_status">Disconnected</span></div>
      <nav>
        <button data-view="news">News</button>
        <button data-view="blog">Blog</button>
        <button data-view="explore">Explore</button>
        <button data-view="post">Post</button>
        <button data-view="config">Config</button>
      </nav>
      <div id="view"></div>
    </div>
  </div>
`

// utility functions
const format_date = timestamp => new Date(timestamp).toLocaleString()

// update system
function manage_updates(start = true) {
  if (state.update_interval) clearInterval(state.update_interval)
  if (start && ['news', 'explore'].includes(state.current_view)) {
    state.update_interval = setInterval(() => render_view(state.current_view), 500)
  }
}

// core functionality
async function join_network() {
  const username = document.getElementById('username').value.trim() || state.username
  if (!username) return alert('Enter your name')
  
  localStorage.setItem('username', username)
  state.username = username
  
  document.getElementById('login').style.display = 'none'
  document.getElementById('main').style.display = 'block'
  
  try {
    document.getElementById('connection_status').textContent = 'Connecting...'
    state.connection_status = 'connecting'
    
    const { store, blog_core } = await start_browser_peer({ name: username, relay: state.custom_relay })
    state.store = store
    state.blog_core = blog_core
    await blog_helper.init_blog(store, username)
    
    state.connection_status = 'connected'
    document.getElementById('connection_status').textContent = 
      `Connected as ${username} (${state.custom_relay ? 'Custom Relay' : 'Default Relay'})`
    
    // event handlers with explicit UI refresh
    store.on('feed', async (core) => {
      await blog_helper.handle_new_core(core)
      if (state.current_view === 'explore') {
        render_view('explore')
      }
    })
    
    blog_helper.on_update(() => {
      if (['news', 'explore'].includes(state.current_view)) render_view(state.current_view)
    })
    
    manage_updates(true)
    show_view('news')
  } catch (err) {
    state.connection_status = 'error'
    document.getElementById('connection_status').textContent = 'Connection Error'
    document.getElementById('view').innerHTML = `
      <div class="error">
        <p>Connection error</p>
        <button onclick="location.reload()">Retry</button>
        ${state.custom_relay ? '<button onclick="reset_relay()">Default Relay</button>' : ''}
      </div>
    `
  }
}

// unified view system
function show_view(name) {
  // dont allow view changes if not connected yet
  if (!state.store && state.connection_status !== 'error') {
    alert("Let him join first man :|")
    return
  }

  state.current_view = name
  document.querySelectorAll('nav button').forEach(btn => 
    btn.classList.toggle('active', btn.dataset.view === name)
  )
  render_view(name)
  manage_updates(['news', 'explore'].includes(name))
}

// unified render function
function render_view(view) {
  const renderers = {
    news: () => {
      // get all posts from all sources
      const posts = [
        ...blog_helper.get_my_posts().map(p => ({...p, is_own: true})),
        ...Array.from(blog_helper.get_peer_blogs().entries()).flatMap(([key, peer]) => 
          (peer.posts || []).map(p => ({...p, peer_key: key, peer_name: peer.username || 'Unknown'}))
        )
      ].sort((a, b) => b.created - a.created)
      
      return `
        <div><h3>News Feed</h3><small>Total Posts: ${posts.length}</small></div>
        ${posts.map(p => `
          <div>
            <h3>${p.title}</h3>
            <small>${p.is_own ? 'You' : p.peer_name} - ${format_date(p.created)}</small>
            <p>${typeof p.content === 'string' ? p.content : 'Content unavailable'}</p>
            <hr>
          </div>
        `).join('') || '<p>No posts yet</p>'}
      `
    },
    
    blog: () => {
      const posts = blog_helper.get_my_posts()
        .sort((a, b) => b.created - a.created)
        .map(p => `
          <div>
            <h3>${p.title}</h3>
            <small>${format_date(p.created)}</small>
            <p>${typeof p.content === 'string' ? p.content : ''}</p>
            <hr>
          </div>
        `).join('')
      return posts || '<p>No posts yet</p>'
    },
    
    explore: () => {
      const my_key = b4a.toString(blog_helper.get_my_core_key(), 'hex')
      const blogs = Array.from(blog_helper.get_discovered_blogs().entries())
        .filter(([key, data]) => key !== my_key && data.username && data.title && data.drive_key)
        .map(([key, data]) => {
          const is_subscribed = blog_helper.get_peer_blogs().has(key)
          const peer_type = data.mode === 'native' ? ' (Native)' : ''
          return `
            <div>
              <b>${data.title}</b> ${peer_type}
              <button onclick="${is_subscribed ? 'unsub' : 'sub'}('${key}')">
                ${is_subscribed ? 'Unsubscribe' : 'Subscribe'}
              </button>
              <hr>
            </div>
          `
        }).join('')
      return blogs || '<p>No blogs discovered</p>'
    },
    
    post: () => `
      <input id="post_title" placeholder="Title"><br>
      <textarea id="post_content" rows="5"></textarea><br>
      <button onclick="publish()">Publish</button>
    `,
    
    config: () => {
      const current_relay = state.custom_relay || (location.hostname === 'localhost' ? 
        'ws://localhost:8080' : 'wss://p2p-relay-production.up.railway.app')
      return `
        <div>
          <h3>Connection Status</h3>
          <p>Status: ${state.connection_status}</p>
          <p>Current Relay: ${current_relay}</p>
        </div>
        <div>
          <h3>Raw Data Viewer</h3>
          <button onclick="show_raw_data()">Show Raw Core Data</button>
          <div id="raw_data"></div>
        </div>
        <div>
          <h3>Relay Server</h3>
          <input id="relay_input" placeholder="ws://localhost:8080 or wss://your-relay.com">
          <button onclick="set_relay()">Set Relay</button>
          ${state.custom_relay ? '<button onclick="reset_relay()">Reset to Default</button>' : ''}
        </div>
        <div>
          <h3>Reset Everything</h3>
          <p>Warning: This will delete all your data</p>
          <button onclick="reset_all()">Reset</button>
        </div>
      `
    }
  }
  
  document.getElementById('view').innerHTML = renderers[view]?.() || '<p>View not found</p>'
}

// raw data viewer function
window.show_raw_data = async () => {
  const raw_div = document.getElementById('raw_data')
  raw_div.innerHTML = '<h4>Loading core data...</h4>'
  
  try {
    if (!state.blog_core) throw new Error('Blog core not initialized')

    const entries = []
    for (let i = 0; i < state.blog_core.length; i++) {
      const entry = JSON.parse(b4a.toString(await state.blog_core.get(i)))
      entries.push(`Entry ${i}: ${JSON.stringify(entry, null, 2)}`)
    }
    
    raw_div.innerHTML = `
      <h4>Blog Core Data</h4>
      <pre style="background: #f0f0f0; padding: 10px; overflow: auto; max-height: 400px">
${entries.join('\n\n')}
      </pre>
    `
  } catch (err) {
    raw_div.innerHTML = `<p style="color: red">Error loading data: ${err.message}</p>`
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
window.unsub = key => blog_helper.unsubscribe(key) && show_view('explore')

window.set_relay = () => {
  const relay = document.getElementById('relay_input').value.trim()
  if (!relay) return
  if (!relay.startsWith('ws://') && !relay.startsWith('wss://')) {
    return alert('Relay must start with ws:// or wss://')
  }
  localStorage.setItem('custom_relay', relay)
  location.reload()
}

window.reset_relay = () => {
  localStorage.removeItem('custom_relay')
  location.reload()
}

window.reset_all = async () => {
  if (confirm('Reset everything?')) {
    await reset_peer_state(state.username)
    localStorage.clear()
    location.reload()
  }
}

// cleanup and initialization
window.addEventListener('beforeunload', () => manage_updates(false))

// event listeners
document.getElementById('join_btn').addEventListener('click', join_network)
document.querySelectorAll('nav button').forEach(btn => 
  btn.addEventListener('click', () => show_view(btn.dataset.view))
)

// auto-join if we have a username
if (state.username) join_network()