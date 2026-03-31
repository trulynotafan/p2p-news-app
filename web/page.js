localStorage.clear()
const STATE = require('STATE')
const statedb = STATE(__filename)
statedb.admin()

const { sdb } = statedb(fallback_module)

const news = require('news')

console.log('p2p news app')

const customVault = {
  init_blog: async ({ username }) => console.log('[customVault] init_blog:', username),
  get_peer_blogs: async () => new Map(),
  get_my_posts: async () => [],
  get_profile: async (key) => null,
  on_update: (callback) => console.log('[customVault] on_update registered')
}

async function init() {
  console.log('[page.js] init started')
  const start = await sdb.watch(handle_watch_batch)

  function handle_watch_batch(batch) {
    console.log('[page.js] sdb watch batch:', batch)
  }

  if (!start || start.length === 0) {
    console.error('[page.js] No active instances found for news')
    return
  }

  const { sid } = start[0]
  console.log('[page.js] Retrieved sid for news:', sid)

  const app = await news({ sid, vault: customVault })
  document.body.innerHTML = ''
  document.body.append(app)
}

init().catch(console.error)

function fallback_module() {
  return {
    _: {
      news: {
        $: '',
        0: '',
        mapping: {
          style: 'style',
          entries: 'entries',
          theme: 'theme',
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
      'style/': {},
      'entries/': {},
      'theme/': {},
      'runtime/': {
        'viewer_data.json': { raw: '{}' }
      },
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
