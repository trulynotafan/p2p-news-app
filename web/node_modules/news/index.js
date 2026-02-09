const STATE = require('STATE')
console.log('[DEBUG] news/index.js running')
const statedb = STATE(__filename)
const { get } = statedb(fallback_module)
const wrapper = require('./wrapper')

// const blog_app = require('p2p-news-app') // Commented out for now

module.exports = news_app

async function news_app (opts = {}) {
  console.log('[news_app] called with opts:', opts)
  const { sid, vault } = opts

  const sidebar = document.createElement('div')
  sidebar.classList.add('sidebar')

  const main = document.createElement('div')
  main.classList.add('main')

  const container = document.createElement('div')
  container.classList.add('container')

  // Styles moved to init
  // container.appendChild(style)

  container.appendChild(sidebar)
  container.appendChild(main)

  await init(vault, sidebar, main, sid, container)

  return container
}

async function init (vault, sidebarEl, mainEl, sid, container) {
  try {
    console.log('[news/index.js] init called with sid:', sid)
    const { id, sdb } = await get(sid)

    console.log('[news/index.js] Got id:', id)

    // Load shell.css from drive
    if (sdb && sdb.drive) {
      const cssFile = await sdb.drive.get('theme/shell.css').catch(() => null)
      if (cssFile && cssFile.raw) {
        const style = document.createElement('style')
        style.textContent = cssFile.raw
        container.appendChild(style)
      }
    }

    const subs = await sdb.watch(async (batch) => {
      console.log('[news/index.js] Watch batch:', batch)
    })

    console.log('[news/index.js] Watch returned:', subs)

    if (!subs || subs.length === 0) {
      console.error('[news/index.js] No active instances found for wrapper')
      return
    }

    const wrapper_instance = subs[0]
    const { sid: wrapper_sid } = wrapper_instance
    console.log('[news/index.js] Retrieved sid for wrapper:', wrapper_sid)

    const sidebar_component = await wrapper({
      id: 'sidebar',
      sid: wrapper_sid,
      ids: { up: id }
    }, (send) => {
      return (msg) => {
        console.log('Host received:', msg)
      }
    })

    sidebarEl.appendChild(sidebar_component)
  } catch (err) {
    console.error('Error initializing news app:', err)
    const errorMsg = document.createElement('p')
    errorMsg.style.color = 'red'
    errorMsg.textContent = `Error: ${err.message}`
    mainEl.innerHTML = ''
    mainEl.appendChild(errorMsg)
  }
}

function fallback_module () {
  function fallback_instance () {
    return {
      _: {
        './wrapper': {
          0: '',
          mapping: {
            theme: 'theme',
            entries: 'entries',
            runtime: 'runtime',
            mode: 'mode',
            flags: 'flags',
            keybinds: 'keybinds',
            undo: 'undo',
            'my-stories': 'my-stories',
            feeds: 'feeds',
            lists: 'lists',
            discover: 'discover'
          }
        }
      },
      drive: {
        'entries/': {
          'entries.json': {
            $ref: 'entries.json'
          }
        },
        'theme/': {
          'shell.css': {
            raw: `
    body { margin: 0; padding: 0; overflow: hidden; }
    .container {
      display: flex;
      width: 100vw;
      height: 100vh;
      overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    .sidebar {
      width: 250px;
      min-width: 250px;
      border-right: 1px solid #e5e7eb;
      background: #f9fafb;
      display: flex;
      flex-direction: column;
    }
    .main {
      flex: 1;
      overflow: auto;
      padding: 2rem;
      background: #ffffff;
    }
                `
          }
        },
        'runtime/': {},
        'mode/': {},
        'flags/': {},
        'keybinds/': {},
        'undo/': {},
        'my-stories/': {},
        'feeds/': {},
        'lists/': {},
        'discover/': {}
      }
    }
  }

  return {
    _: {
      './wrapper': { $: '' }
    },
    api: fallback_instance
  }
}
