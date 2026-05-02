localStorage.clear()
const STATE = require('STATE')
const statedb = STATE(__filename)
statedb.admin()

const { sdb } = statedb(fallback_module)

const news = require('news')

const custom_vault = {
  init_blog: async function init_blog ({ username }) { },
  get_peer_blogs: async function get_peer_blogs () { return new Map() },
  get_my_posts: async function get_my_posts () { return [] },
  get_profile: async function get_profile (key) { return null },
  on_update: function on_update (callback) { }
}

async function init () {
  const start = await sdb.watch(handle_watch_batch)

  function handle_watch_batch (batch) {
  }

  if (!start || start.length === 0) {
    return
  }

  const { sid } = start[0]

  const app = await news({ sid, vault: custom_vault })
  document.body.innerHTML = ''
  document.body.append(app)
}

init().catch(function handle_init_error () { })

function fallback_module () {
  return {
    _: {
      news: {
        $: '',
        0: {
          _: {
            newsfeed_view: { $: '' },
            write_page: { $: '' },
            './graphdb': { $: '' },
            'newsfeed_view/content_parser': { $: '' },
            net_helper: { $: '' }
          }
        },
        mapping: {
          style: 'style',
          entries: 'entries',
          theme: 'theme',
          runtime: 'runtime',
          mode: 'mode',
          flags: 'flags',
          keybinds: 'keybinds',
          undo: 'undo',
          posts: 'posts',
          data: 'data',
          news_cards: 'news_cards'
        }
      }
    },
    drive: {
      'style/': {},
      'entries/': {},
      'theme/': {},
      'runtime/': {
        'viewer_data.json': { raw: '{}' },
        'write_data.json': { raw: '{}' }
      },
      'mode/': {},
      'flags/': {},
      'keybinds/': {},
      'undo/': {},
      'posts/': {},
      'data/': {},
      'news_cards/': {}
    }
  }
}
