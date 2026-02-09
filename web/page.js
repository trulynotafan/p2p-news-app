localStorage.clear()
const STATE = require('STATE')
const statedb = STATE(__filename)
statedb.admin()

function fallback_module () {
  return {
    _: {
      news: {
        $: '',
        0: '',
        mapping: {
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
      'entries/': {},
      'theme/': {},
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

const { sdb } = statedb(fallback_module)

console.log('p2p news app')
const news = require('news')

const customVault = {
  init_blog: async ({ username }) => {
    console.log('[customVault] init_blog:', username)
  },
  get_peer_blogs: async () => {
    console.log('[customVault] get_peer_blogs')
    return new Map()
  },
  get_my_posts: async () => {
    console.log('[customVault] get_my_posts')
    return []
  },
  get_profile: async (key) => {
    console.log('[customVault] get_profile:', key)
    return null
  },
  on_update: (callback) => {
    console.log('[customVault] on_update registered')
  }
}

async function init () {
  console.log('[page.js] init started')

  const start = await sdb.watch(async (batch) => {
    console.log('[page.js] sdb watch batch:', batch)
  })

  console.log('[page.js] Watch returned:', start)

  if (!start || start.length === 0) {
    console.error('[page.js] No active instances found for news')
    return
  }

  const news_instance = start[0]
  const { sid } = news_instance
  console.log('[page.js] Retrieved sid for news:', sid)

  const app = await news({ sid, vault: customVault })
  document.body.append(app)
}

init().catch(console.error)
