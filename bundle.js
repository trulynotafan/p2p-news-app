(function(){function r(e,n,t){function o(i,f){if(!n[i]){if(!e[i]){var c="function"==typeof require&&require;if(!f&&c)return c(i,!0);if(u)return u(i,!0);var a=new Error("Cannot find module '"+i+"'");throw a.code="MODULE_NOT_FOUND",a}var p=n[i]={exports:{}};e[i][0].call(p.exports,function(r){var n=e[i][1][r];return o(n||r)},p,p.exports,r,e,n,t)}return n[i].exports}for(var u="function"==typeof require&&require,i=0;i<t.length;i++)o(t[i]);return o}return r})()({1:[function(require,module,exports){
(function (Buffer){(function (){
// P2P News App.. Blog application that receives identity (vault) as parameter
// Exports a single constructor function named blog_app
const b4a = require('b4a')

// Blog-specific topic for swarm discovery
const BLOG_TOPIC = b4a.from('ffb09601562034ee8394ab609322173b641ded168059d256f6a3d959b2dc6021', 'hex')

// App ID for vault registration
const APP_ID = 'p2p-news-app'

module.exports = blog_app

function blog_app (identity) {
  // identity is the vault object from the identity module

// ============================================================================
// DATA STRUCTURES, The only place we need to define structures.. 
// ============================================================================
// To add a new structure just add ONE line here:
// - name: identifier for the structure (e.g., 'comments', 'likes', 'media')
// - namespace: storage namespace (e.g., 'blog-comments', 'chat-messages')
// - type: 'autobase' for structured data, 'autodrive' for files (Both are multidevice obviously)
// - encoding: (autobase only) 'json' or something else
// - view_name: (autobase only) name for the view hypercore
//
// The datastructure-manager handles this automatically:
// registration, initialization, pairing, replication,  writer management
// ============================================================================
const STRUCTURES = [
  { name: 'metadata', namespace: 'blog-metadata', type: 'autobase', encoding: 'json', view_name: 'blog-view' },
  { name: 'drive', namespace: 'blog-files', type: 'autodrive' },
  { name: 'profile', namespace: 'blog-profile', type: 'autodrive' },
  { name: 'events', namespace: 'blog-events', type: 'autodrive' },
  { name: 'app_audit', namespace: 'blog-audit', type: 'auditcore' },
  // ADD NEW STRUCTURES, Just one line. Example:
  // { name: 'comments', namespace: 'blog-comments', type: 'autodrive' }
]
// ============================================================================

// Global state
let store, ds_manager, pairing_manager, pairing_result = null
const discovered_blogs = new Map()
const peer_relays = new Map() // Store relay URLs for peers
const autobase_cache = new Map()
const drive_cache = new Map()
const emitter = make_emitter()

  // Return the blog app API
  const api = {
    init_blog,
    create_post,
    create_invite,
    verify_pairing,
    deny_pairing,
    subscribe,
    unsubscribe,
    get_blog_username,
    get_blog_profile_drive_key,
    get_blog_events_drive_key,
    get_my_posts,
    get_peer_blogs,
    // Profile management
    get_profile,
    get_avatar_content,
    upload_avatar,
    create_default_profile,
    // Device/pairing management
    log_event,
    get_paired_devices,
    remove_device,
    get_raw_data,
    // Relay management
    set_peer_relay,
    // Other getters
    get_local_key,
    get_drive,
    get_profile_drive,
    get_autobase_key,
    get_autobase,
    get_metadata_store,
    get_drive_store,
    get_profile_store,
    get_events_store,
    get_discovered_blogs,
    get_structure_names,
    on_update: (cb) => emitter.on('update', cb)
  }

  return api


// ============================================================================
// Internal functions
// ============================================================================

// Audit logging helper
async function audit_log (op, data = {}) {
  const app_audit = ds_manager?.get('app_audit')
  if (app_audit) await app_audit.append({ type: op, data })
}

// Store relay URL for a peer (called from protocol exchange)
function set_peer_relay (key, relay_url) {
  if (relay_url) peer_relays.set(key, relay_url)
}

// Setup peer autobase
async function setup_peer_autobase (key, key_buffer) {
  // Check if already exists
  if (autobase_cache.has(key)) return autobase_cache.get(key)
  
  // Use datastructure-manager to create peer metadata autobase
  const peer_autobase = await ds_manager.create_peer_structure('metadata', key, key_buffer, store)

  // Wait for data if empty
  if (peer_autobase.view.length === 0) {
    await new Promise(resolve => peer_autobase.once('update', resolve))
  }

  async function handle_peer_autobase_update () {
    if (peer_autobase.view.length > 0) {
      try {
        const init_raw_data = await peer_autobase.view.get(0)
        const init_entry = JSON.parse(init_raw_data)
        
        if (validate_blog_init(init_entry)) {
          discovered_blogs.set(key, {
            username: init_entry.data.username,
            title: init_entry.data.title,
            drive_key: init_entry.data.drive_key,
            relay_url: peer_relays.get(key) || null
          })
          
          // Setup peer drive
          if (!drive_cache.has(key) && init_entry.data.drive_key) {
            const drive_key_buffer = b4a.from(init_entry.data.drive_key, 'hex')
            const peer_drive = await ds_manager.create_peer_structure('drive', key, drive_key_buffer, store)
            drive_cache.set(key, peer_drive)
          }
          
          emitter.emit('update')
        }
      } catch (err) {
        console.error('[setup_peer_autobase] Error processing update:', err)
      }
    }
  }

  peer_autobase.on('update', handle_peer_autobase_update)
  await handle_peer_autobase_update()
  
  autobase_cache.set(key, peer_autobase)
  return peer_autobase
}

// Restore subscribed peers
function restore_subscribed_peers () {
  if (!store) return
  
  async function handle_peer_key (key) {
    try {
      const key_buffer = b4a.from(key, 'hex')
      await setup_peer_autobase(key, key_buffer)
    } catch (err) {
      console.error('Error restoring peer:', err)
    }
  }
  
  get_subscribed_peers().forEach(handle_peer_key)
}

// VAULT REGISTRATION - Register app structures with vault on init
async function register_app_with_vault () {
  const vault_bee = identity.get_vault_bee()

  // Get structure keys for registration
  const structure_keys = {}
  for (const config of STRUCTURES) {
    const key = ds_manager.get_key(config.name)
    if (key) {
      structure_keys[config.name] = key
    }
  }

  // Register app with vault
  await identity.register_app(APP_ID, {
    name: 'P2P News App',
    structures: STRUCTURES.map(s => ({
      name: s.name,
      namespace: s.namespace,
      type: s.type,
      key: structure_keys[s.name]
    })),
    registered_at: Date.now()
  })

  // Link app auditcore to vault's root auditcore
  const vault_audit = identity.get_vault_audit()
  const app_audit_key = structure_keys.app_audit
  if (vault_audit && app_audit_key) {
    await vault_audit.append({ type: 'app_audit_linked', data: { app_id: APP_ID, audit_key: app_audit_key } })
  }
}

// WRITER KEY WATCHER - Watch vault for writer key requests from paired devices
async function start_writer_watcher () {
  const vault_bee = identity.get_vault_bee()
  if (!vault_bee) return

  const watcher = vault_bee.watch({ gte: `writer_requests/${APP_ID}`, lt: `writer_requests/${APP_ID}0` })

  ;(async () => {
    for await (const _ of watcher) {
      const requests = await identity.vault_get(`writer_requests/${APP_ID}`)
      if (!requests) continue

      let processed_any = false
      for (const req of requests) {
        if (req.processed) continue
        processed_any = true
        for (const [name, key] of Object.entries(req.writer_keys)) {
          try {
            await ds_manager.add_writer(name, key)
            console.log(`[p2p-news-app] Added writer to ${name}:`, key)
          } catch (err) {
            console.error(`[p2p-news-app] Failed to add writer to ${name}:`, err.message)
          }
        }
        req.processed = true
        req.processed_at = Date.now()

        // Log Device B as a paired device with all its writer keys
        const device_keys = {}
        for (const [name, key] of Object.entries(req.writer_keys)) {
          device_keys[`${name}_writer`] = key
        }
        await log_event('add', device_keys)
      }
      if (processed_any) {
        await identity.vault_put(`writer_requests/${APP_ID}`, requests)
        emitter.emit('update')
      }
    }
  })()
}

// Initialize blog
async function init_blog (options) {
  const { username, relay, offline_mode } = options

  // Check if vault already exists (pair mode)
  const vault_bee = identity.get_vault_bee()
  const network_store = identity.get_network_store()
  const swarm_instance = identity.get_swarm()

  if (vault_bee && network_store && swarm_instance) {
    store = network_store
    ds_manager = identity.create_ds_manager()
    identity.set_ds_manager(ds_manager)
    STRUCTURES.forEach(c => ds_manager.register({ ...c, store }))

    const app = await identity.get_app(APP_ID)
    if (!app?.structures) throw new Error('Could not sync with vault. Make sure Device A is online.')

    const keys_map = Object.fromEntries(app.structures.filter(s => s.key).map(s => [s.name, s.key]))
    await ds_manager.init_all_with_keys(keys_map)
    await request_app_writer_access()
    await wait_for_writer_access()

    identity.set_events_drive(ds_manager.get('events'), ds_manager.get_store('events'))
    setup_peer_handlers()
    return { store, swarm: swarm_instance }
  }

  // SEED MODE: Start networking, create vault, then app structures
  const networking_options = {
    name: username,
    store_name: `storage-${username}`,
    topic: BLOG_TOPIC,
    get_primary_key: () => ds_manager ? ds_manager.get_key('metadata') : null,
    get_primary_structure: () => ds_manager ? ds_manager.get('metadata') : null,
    relay,
    offline_mode
  }

  const { store: _store, swarm: _swarm } = await identity.start_networking(networking_options)
  store = _store

  identity.set_swarm(_swarm)

  // Create vault structures in this store
  await identity.init_vault_structures(store, null, null)

  // Save vault keys to localStorage
  const vault_bee_key = identity.get_vault_bee()?.key
  const vault_audit_key = identity.get_vault_audit()?.key
  if (vault_bee_key && vault_audit_key && typeof localStorage !== 'undefined') {
    localStorage.setItem(`vault_keys_${username}`, JSON.stringify({
      vault_bee: b4a.toString(vault_bee_key, 'hex'),
      vault_audit: b4a.toString(vault_audit_key, 'hex')
    }))
  }

  // Now create app structures
  ds_manager = identity.create_ds_manager()
  identity.set_ds_manager(ds_manager)
  for (const config of STRUCTURES) {
    ds_manager.register({ ...config, store })
  }

  await ds_manager.init_all()
  const metadata = ds_manager.get('metadata')
  await metadata.append({
    type: 'blog-init',
    data: { username, title: `${username}'s Blog`, drive_key: ds_manager.get_key('drive') }
  })

  await create_default_profile(username)
  await log_bootstrap_device()

  // Register app in vault
  await register_app_with_vault()

  const events_drive = ds_manager.get('events')
  identity.set_events_drive(events_drive, ds_manager.get_store('events'))

  start_writer_watcher()
  setup_peer_handlers()

  return { store, swarm: _swarm }
}

// Setup peer discovery handlers
function setup_peer_handlers () {
  const metadata = ds_manager.get('metadata')

  store.on('peer-autobase-key', async ({ key, key_buffer, relay_url }) => {
    if (key === ds_manager.get_key('metadata')) return
    if (relay_url) set_peer_relay(key, relay_url)
    if (autobase_cache.has(key)) return
    await setup_peer_autobase(key, key_buffer)
  })

  metadata.on('update', () => emitter.emit('update'))
  restore_subscribed_peers()
}

// Log bootstrap device with ALL structure writer keys (also dynamic)
async function log_bootstrap_device () {
  const device_keys = {}
  for (const name of ds_manager.get_names()) {
    const structure = ds_manager.get(name)
    const config = ds_manager.get_config(name)

    let writer_key = null
    if (config.type === 'autobase') {
      writer_key = structure.local?.key
    } else if (config.type === 'autodrive') {
      writer_key = structure.base?.local?.key
    } else if (config.type === 'auditcore') {
      writer_key = structure.base?.local?.key
    }
    if (writer_key) {
      device_keys[`${name}_writer`] = b4a.toString(writer_key, 'hex')
    }
  }
  const existing_devices = await get_paired_devices()
  const device_exists = existing_devices.some(d => d.metadata_writer === device_keys.metadata_writer)

  if (!device_exists) {
    await log_event('add', device_keys)
  }
}

// Create invite
async function create_invite () {
  const { invite_code, invite } = await identity.create_vault_invite(BLOG_TOPIC)
  const profile = await get_profile()

  pairing_manager = await identity.setup_vault_pairing({
    invite,
    username: profile?.name || 'Unknown',
    on_verification_needed: (digits) => emitter.emit('verification_needed', digits),
    on_paired: async ({ vault_bee_writer, vault_audit_writer }) => {
      // Vault pairing complete - vault keys are handled by identity module
      // Device entries are created when app structures get writer access, not here
      console.log('[p2p-news-app] Vault paired with new device')
      emitter.emit('update')
    }
  })
  return { invite_code, pairing_manager }
}

function verify_pairing (code) { return identity.verify_vault_pairing(code) }

function deny_pairing () {
  identity.deny_vault_pairing()
  emitter.emit('update')
}

// Request writer access (Device B side)
async function request_app_writer_access () {
  if (!identity.get_vault_bee()) return

  const writer_keys = {}
  for (const name of ds_manager.get_names()) {
    const key = get_local_writer_key(ds_manager.get(name), ds_manager.get_config(name).type)
    if (key) writer_keys[name] = b4a.toString(key, 'hex')
  }

  const requests = await identity.vault_get(`writer_requests/${APP_ID}`) || []
  requests.push({ writer_keys, requested_at: Date.now(), processed: false })
  await identity.vault_put(`writer_requests/${APP_ID}`, requests)
  return writer_keys
}

// Wait for Device A to process our writer access request
async function wait_for_writer_access () {
  const vault_bee = identity.get_vault_bee()
  const our_key = ds_manager.get('metadata')?.local?.key
  if (!vault_bee || !our_key) return false

  const our_hex = b4a.toString(our_key, 'hex')
  for await (const _ of vault_bee.watch({ gte: `writer_requests/${APP_ID}`, lt: `writer_requests/${APP_ID}0` })) {
    const reqs = await identity.vault_get(`writer_requests/${APP_ID}`)
    if (reqs?.find(r => r.writer_keys?.metadata === our_hex && r.processed)) return true
  }
}

// Create post
async function create_post (title, content) {
  const drive = ds_manager.get('drive')
  const metadata = ds_manager.get('metadata')
  
  const created = Date.now()
  const filepath = `/posts/${created}.json`
  const post_data = { title, content, created }
  
  await drive.put(filepath, Buffer.from(JSON.stringify(post_data)))
  await metadata.append({
    type: 'blog-post',
    data: { filepath, created }
  })
  await audit_log('create_post', { title, filepath })
}

// Profile management (app-specific, not in identity)
async function create_default_profile (username) {
  const profile_drive = ds_manager.get('profile')
  
  // use the profile pic if it exists
  if (await profile_drive.get('/profile.json')) return
  
  const default_avatar = `<svg><text x="50%" y="50%" font-size="120" text-anchor="middle" dominant-baseline="middle">👤</text></svg>`
  
  await profile_drive.put('/avatar.svg', b4a.from(default_avatar))
  await profile_drive.put('/profile.json', b4a.from(JSON.stringify({
    name: username,
    avatar: '/avatar.svg'
  })))
}

async function upload_avatar (imageData, filename) {
  const profile_drive = ds_manager.get('profile')
  if (!profile_drive) {
    throw new Error('Profile drive not initialized')
  }
  
  // Get file extension from filename
  const ext = filename.split('.').pop().toLowerCase()
  const avatar_path = `/avatar.${ext}`
  
  // Store the image file
  await profile_drive.put(avatar_path, b4a.from(imageData))
  
  // Update profile.json to point to the new avatar
  const profile = await get_profile()
  const updated_profile = {
    ...profile,
    avatar: avatar_path
  }
  
  await profile_drive.put('/profile.json', b4a.from(JSON.stringify(updated_profile)))
  await audit_log('upload_avatar', { avatar_path })
  emitter.emit('update')
}

async function get_profile (profile_key = null) {
  // If string key passed, ignore it
  if (typeof profile_key === 'string') return null
  
  const profile_drive = ds_manager.get('profile')
  if (!profile_drive) return null
  
  try {
    await profile_drive.ready()  
    const profile_data = await profile_drive.get('/profile.json')
    if (!profile_data) return null
    return JSON.parse(b4a.toString(profile_data))
  } catch (err) {
    console.error('Error getting profile:', err)
    return null
  }
}

async function get_avatar_content (profile_key = null) {
  const profile_drive = ds_manager.get('profile')
  if (!profile_drive) return null
  
  try {
    await profile_drive.ready()
    
    // Get profile to find avatar path
    const profile = await get_profile(profile_key)
    if (!profile || !profile.avatar) return null
    
    const avatar_data = await profile_drive.get(profile.avatar)
    if (!avatar_data) return null
    
    // For SVG files, return as text
    if (profile.avatar.endsWith('.svg')) {
      return b4a.toString(avatar_data)
    }
    
    // For image files, return as data URL
    const ext = profile.avatar.split('.').pop().toLowerCase()
    const mimeType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`
    const base64 = b4a.toString(avatar_data, 'base64')
    return `data:${mimeType};base64,${base64}`
  } catch (err) {
    return null
  }
}

// Device/pairing management (delegates to identity with events_drive)
async function log_event (type, data) {
  const events_drive = ds_manager.get('events')
  return identity.log_event(events_drive, type, data)
}

async function get_paired_devices () {
  const events_drive = ds_manager.get('events')
  return identity.get_paired_devices(events_drive)
}

async function remove_device (device) {
  const events_drive = ds_manager.get('events')
  await audit_log('remove_device', { device })
  return identity.remove_device(events_drive, device)
}

async function get_raw_data (structure_name) {
  return identity.get_raw_data(structure_name)
}

// Subscribe to peer
async function subscribe (key) {
  if (!key || typeof key !== 'string') return false
  
  const my_key = ds_manager.get_key('metadata')
  if (key === my_key) return false
  
  try {
    const key_buffer = b4a.from(key, 'hex')
    await setup_peer_autobase(key, key_buffer)
    add_subscribed_peer(key)
    await audit_log('subscribe', { peer_key: key })
    emitter.emit('update')
    return true
  } catch (err) {
    console.error('Subscribe error:', err)
    return false
  }
}

// Unsubscribe
async function unsubscribe (key) {
  remove_subscribed_peer(key)
  
  const peer_autobase = autobase_cache.get(key)
  if (peer_autobase) {
    await peer_autobase.close()
    autobase_cache.delete(key)
  }
  
  const peer_drive = drive_cache.get(key)
  if (peer_drive) {
    await peer_drive.close()
    drive_cache.delete(key)
  }
  
  await audit_log('unsubscribe', { peer_key: key })
  // Keep in discovered_blogs so it shows in "Discovered Peers" again
  emitter.emit('update')
}

// Get blog username
async function get_blog_username () {
  if (!ds_manager) return null
  const metadata = ds_manager.get('metadata')
  if (!metadata || !metadata.view || metadata.view.length === 0) return null
  
  try {
    const init_raw = await metadata.view.get(0)
    const init_entry = JSON.parse(init_raw)
    return validate_blog_init(init_entry) ? init_entry.data.username : null
  } catch {
    return null
  }
}

// Get blog drive keys
async function get_blog_drive_key (key_name) {
  const metadata = ds_manager.get('metadata')
  if (!metadata || metadata.view.length < 2) return null
  
  try {
    const extended_raw = await metadata.view.get(1)
    const extended_entry = JSON.parse(extended_raw)
    return extended_entry.data?.[key_name] || null
  } catch {
    return null
  }
}

function get_blog_profile_drive_key () {
  return get_blog_drive_key('profile_drive_key')
}

function get_blog_events_drive_key () {
  return get_blog_drive_key('events_drive_key')
}

// Get posts
async function get_posts (key = null) {
  const target_key = key || ds_manager.get_key('metadata')
  const is_my_blog = !key || key === ds_manager.get_key('metadata')
  
  const metadata = is_my_blog ? ds_manager.get('metadata') : autobase_cache.get(target_key)
  const drive = is_my_blog ? ds_manager.get('drive') : drive_cache.get(target_key)
  
  if (!metadata || !drive) return []
  if (!metadata.view || !metadata.view.length) return []
  
  const posts = []
  
  for (let i = 0; i < metadata.view.length; i++) {
    try {
      const raw = await metadata.view.get(i)
      const entry = JSON.parse(raw)
      
      if (validate_blog_post(entry)) {
        const post_buffer = await drive.get(entry.data.filepath)
        if (post_buffer) {
          const post = JSON.parse(post_buffer.toString())
          posts.push(post)
        }
      }
    } catch (err) {
      console.error('Error reading post:', err)
    }
  }
  
  return posts.sort((a, b) => b.created - a.created)
}

function get_my_posts () {
  return get_posts()
}

// Get peer blogs
async function get_peer_blogs () {
  const blogs = new Map()
  
  for (const key of get_subscribed_peers()) {
    const blog_data = discovered_blogs.get(key)
    if (blog_data) {
      const posts = await get_posts(key)
      blogs.set(key, { ...blog_data, posts })
    }
  }
  
  return blogs
}

// Getters
function get_drive () {
  return ds_manager ? ds_manager.get('drive') : null
}
function get_profile_drive () {
  return ds_manager ? ds_manager.get('profile') : null
}
function get_autobase_key () {
  return ds_manager ? ds_manager.get_key('metadata') : null
}
function get_autobase () {
  return ds_manager ? ds_manager.get('metadata') : null
}
function get_metadata_store () {
  return ds_manager ? ds_manager.get_store('metadata') : null
}
function get_drive_store () {
  return ds_manager ? ds_manager.get_store('drive') : null
}
function get_profile_store () {
  return ds_manager ? ds_manager.get_store('profile') : null
}
function get_events_store () {
  return ds_manager ? ds_manager.get_store('events') : null
}
function get_local_key () {
  const metadata = ds_manager.get('metadata')
  return metadata ? b4a.toString(metadata.local.key, 'hex') : null
}
function get_discovered_blogs () {
  return discovered_blogs
}
function get_pairing_result () {
  return pairing_result
}
function get_structure_names () {
  return ds_manager ? ds_manager.get_names() : []
}

}

// ============================================================================
// GENERAL HELPER FUNCTIONS
// ============================================================================

/***************************************
MAKE EMITTER
***************************************/
function make_emitter (state = {}) {
  return {
    on: (type, cb) => (state[type] = state[type] || []).push(cb),
    off: (type, cb) => (state[type] = state[type] || [])[state[type].indexOf(cb)] = undefined,
    emit: (type, data) => (state[type] = state[type] || []).map(f => f && f(data))
  }
}

/***************************************
VALIDATE BLOG INIT
***************************************/
function validate_blog_init (entry) {
  const { type, data = {} } = entry || {}
  return type === 'blog-init' &&
         typeof data.username === 'string' &&
         typeof data.title === 'string' &&
         typeof data.drive_key === 'string'
}

/***************************************
VALIDATE BLOG POST
***************************************/
function validate_blog_post (entry) {
  const { type, data = {} } = entry || {}
  return type === 'blog-post' &&
         typeof data.filepath === 'string' &&
         typeof data.created === 'number'
}

/***************************************
LOCAL STORAGE HELPERS
***************************************/
function get_subscribed_peers () {
  try { return JSON.parse(localStorage.getItem('subscribed_peers') || '[]') } catch { return [] }
}

function add_subscribed_peer (key) {
  const peers = get_subscribed_peers()
  if (!peers.includes(key)) {
    peers.push(key)
    localStorage.setItem('subscribed_peers', JSON.stringify(peers))
  }
}

function remove_subscribed_peer (key) {
  localStorage.setItem('subscribed_peers', JSON.stringify(
    get_subscribed_peers().filter(k => k !== key)
  ))
}

/***************************************
GET LOCAL WRITER KEY
***************************************/
function get_local_writer_key (structure, type) {
  if (type === 'autobase') return structure.local?.key
  if (type === 'autodrive' || type === 'auditcore') return structure.base?.local?.key
  return null
}
}).call(this)}).call(this,require("buffer").Buffer)
},{"b4a":3,"buffer":5}],2:[function(require,module,exports){
// webapp-ui receives `uservault` from datashell (after auth)
// this only runs when user is already authenticated

const blog_app = require('p2p-news-app')

// Uservault param is injected by datashell as 'vault'
const uservault = vault
console.log('[webapp-ui] Starting app with uservault:', uservault)

// Global state
let store
let username = uservault.username || localStorage.getItem('username') || ''
  let current_view
  let is_ready = false
  let is_joining = false
  let swarm = null
  let api = null
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

  console.log('[webapp-ui] Setting up blog UI...')
  // Blog app HTML structure (no login UI, handled by vault-ui)
  document.body.innerHTML = `
    <div class="app">
      <div class="main">
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
  function escape_html(str) {
    if (!str) return ''
    if (typeof str !== 'string') str = String(str)
    function get_html_entity(tag) {
      const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
      return entities[tag]
    }
    return str.replace(/[&<>"']/g, get_html_entity)
  }

  // Setup connection status UI
  function setup_connection_status(swarm) {
    const status_el = document.querySelector('.connection-status')
    if (swarm) {
      // Set initial status
      is_joining = false
      if (swarm.connections.size > 0) {
        status_el.textContent = `🟢 Connected as ${username} (${swarm.connections.size} peers)`
      } else {
        status_el.textContent = `🟢 Joined swarm as ${username} (waiting for peers...)`
      }

      function handle_swarm_connection() {
        status_el.textContent = `🟢 Connected as ${username} (${swarm.connections.size} peers)`
        if (current_view) render_view(current_view)
      }

      function handle_swarm_disconnection() {
        status_el.textContent = `🟢 Connected as ${username} (${swarm.connections.size} peers)`
      }

      swarm.on('connection', handle_swarm_connection)
      swarm.on('disconnection', handle_swarm_disconnection)
    } else {
      is_joining = false
      status_el.textContent = '🟠 Offline mode (relay not available)'
    }
  }

  // Initialize blog app (called on page load)
  async function init_blog_app() {
    try {
      document.querySelector('.connection-status').textContent = 'Connecting to relay...'
      is_joining = true

      // Load default relay if set
      default_relay = get_default_relay()

      // Create blog app with vault
      api = blog_app(uservault)

      function handle_blog_update() {
        if (current_view) render_view(current_view)
      }

      api.on_update(handle_blog_update)

    // Init blog with user data (identity already handled pairing if in pair mode)
      const init_options = { username }

      if (default_relay) init_options.relay = default_relay
      
      console.log('[webapp-ui] Calling api.init_blog with options:', init_options)
      const result = await api.init_blog(init_options)
      console.log('[webapp-ui] init_blog succeeded, result:', result)
      store = result.store
      swarm = result.swarm

      // Update username if in pair mode (identity set it during authentication)
      if (uservault.mode === 'pair' && uservault.username) {
        username = uservault.username
        localStorage.setItem('username', username)
      }

      setup_connection_status(swarm)

      is_ready = true
      is_joining = false

      show_view('news')
    } catch (err) {
      is_joining = false
      const error_msg = err.message
      console.error('[webapp-ui] init_blog_app error:', err)
      if (error_msg.includes('Relay connection failed') || error_msg.includes('Relay connection closed')) {
        try {
          const result = await api.init_blog({ username, offline_mode: true })
          store = result.store
          is_ready = true
          setup_connection_status(null)
          show_view('news')
        } catch (e) { }

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

  // View system
  function show_view(name) {
    current_view = name
    function handle_nav_button_toggle(btn) {
      btn.classList.toggle('active', btn.dataset.view === name)
    }
    document.querySelectorAll('nav button').forEach(handle_nav_button_toggle)
    render_view(name)
  }

  // Render function (a bit simplified than before..)
  async function render_view(view, ...args) {
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
        if (posts.length === 0) {
          view_el.innerHTML += '<p>You have not written any posts yet. Go to New Post to create one.</p>'
          return
        }
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
        view_el.innerHTML = '<h3>Create New Post</h3><input class="post-title" placeholder="Title"><textarea class="post-content" placeholder="Content"></textarea><button class="publish-btn">Publish</button>'
        const publish_btn = view_el.querySelector('.publish-btn')
        publish_btn.addEventListener('click', handle_publish)
      },

      config: async () => {
        const my_key = api.get_autobase_key()
        const profile = await api.get_profile()
        const avatar_content = await api.get_avatar_content()
        const raw_data_buttons = await generate_raw_data_buttons()

        // Check if there's a pending pairing request
        const pending_verification = pairing_manager ? pairing_manager.get_pending_verification_digits() : null
        const pairing_section = pending_verification
          ? `<div><h4>Active Pairing Request</h4><p>Enter 6-digit code from new device:</p><input class="verification-input" placeholder="6-digit code" style="width: 150px; padding: 5px; margin-right: 5px;" maxlength="6"><button class="verify-btn" style="padding: 5px 10px; margin-right: 5px;">Verify</button><button class="deny-pairing-btn" style="padding: 5px 10px;">Deny</button><hr></div>`
          : ''

        // Build invite section
        let invite_section = `<div><h4>Create Invite</h4><p>Create an invite to share write access to your blog.</p><button class="create-invite-btn">Create Invite</button><div class="invite-result" style="margin-top: 10px;"></div></div>`

        // Build relay list
        const relays = get_relays()
        const current_default = get_default_relay()
        let relay_list_html = relays.map(r => `<div style="margin: 5px 0;"><span>${escape_html(r)}</span> <button class="relay-default-btn" data-relay="${escape_html(r)}" style="margin-left: 10px;">${r === current_default ? '✓ Default' : 'Set Default'}</button> <button class="relay-remove-btn" data-relay="${escape_html(r)}" style="margin-left: 5px; background: #dc3545; color: white; border: none; padding: 2px 8px; cursor: pointer;">Remove</button></div>`).join('')

        view_el.innerHTML = `<h3>Configuration</h3>${pairing_section}<div><h4>My Profile</h4><p>Your current profile information:</p><div><p><strong>Name:</strong> ${profile ? escape_html(profile.name) : 'Loading...'}</p><div><strong>Avatar:</strong></div><div>${avatar_content ? (avatar_content.startsWith('data:') ? `<img src="${avatar_content}" style="max-width: 100px; max-height: 100px;">` : avatar_content) : 'Loading...'}</div></div><div><input type="file" class="avatar-upload" accept="image/*"><button class="upload-avatar-btn">Upload Profile Picture</button></div></div><hr><div><h4>My Blog Address</h4><p>Share this address with others so they can subscribe to your blog.</p><input class="blog-address-input" readonly value="${my_key}" size="70"><button class="copy-address-btn">Copy</button></div><hr><div><h4>Relays</h4><p>Add custom relays to connect through:</p><input class="relay-input" placeholder="ws://localhost:8080 or wss://relay.example.com" style="width: 400px;"><button class="relay-add-btn">Add Relay</button><div style="margin-top: 10px;">${relay_list_html || '<p style="color: #666;">No custom relays added</p>'}</div></div><hr>${invite_section}<hr><div><h4>Manual Subscribe</h4><p>Subscribe to a blog by its address.</p><input class="manual-key-input" placeholder="Blog Address" size="70"><button class="manual-subscribe-btn">Subscribe</button></div><hr><div><h4>Paired Devices</h4><p>Devices that have write access to this blog:</p><div class="paired-devices-list" style="background: #f5f5f5; padding: 10px; border-radius: 5px; margin: 10px 0;">Loading devices...</div></div><hr><div><h4>Show Raw Data</h4><button class="show-raw-data-btn">Show Raw Data</button><div class="raw-data-options" style="display: none; margin-top: 10px;">${raw_data_buttons}</div><pre class="raw-data-display" style="display: none; background: #f0f0f0; padding: 10px; margin-top: 10px; white-space: pre-wrap; max-height: 300px; overflow-y: auto;"></pre></div><hr><div><h4>Reset</h4><button class="reset-data-btn">Delete All My Data</button></div>`

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
  async function handle_publish() {
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

  async function handle_subscribe(key) {
    await api.subscribe(key)
    render_view('explore')
  }

  async function handle_unsubscribe(key) {
    await api.unsubscribe(key)
    render_view('explore')
  }

  async function handle_create_invite() {
    try {
      const result = await api.create_invite()
      const { invite_code, pairing_manager: pm } = result
      pairing_manager = pm
      const invite_result = document.querySelector('.invite-result')
      invite_result.innerHTML = `
        <p>Invite Code:</p>
        <input class="invite-code-display" readonly value="${invite_code}" style="width: 400px;">
        <button class="copy-invite-btn">Copy</button>
        <p><small>Keep this page open. When a device tries to pair, go to the Config tab to verify the 6-digit code.</small></p>
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

  async function handle_manual_subscribe() {
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

  async function handle_remove_device(button) {
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

      if (window.requestFileSystem || window.webkitRequestFileSystem) {
        const requestFileSystem = window.requestFileSystem || window.webkitRequestFileSystem
        function handle_file_system_cleanup(resolve, reject) {
          function handle_file_system_success(fs) {
            function handle_entries_read(entries) {
              if (!entries.length) return resolve()
              let completed = 0

              function handle_entry_removal() {
                completed++
                if (completed === entries.length) resolve()
              }

              function handle_entry_cleanup(entry) {
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
        try { await store.close() } catch (err) { }
      }

      window.location.reload()
    } catch (err) {
      alert('Reset error: ' + err.message)
    }
  }

  // Generate raw data buttons dynamically (meaning based on the amount of data structures)
  async function generate_raw_data_buttons() {
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
  function handle_raw_data(action, type) {
    const options = document.querySelector('.raw-data-options')
    const display = document.querySelector('.raw-data-display')

    if (action === 'toggle') {
      options.style.display = options.style.display === 'none' ? 'block' : 'none'
      display.style.display = 'none'
      return
    }

    display.textContent = 'Loading...'
    display.style.display = 'block'
    api.get_raw_data(type).then(data => { display.textContent = data }).catch(err => { display.textContent = 'Error: ' + err.message })
  }

  function handle_upload_avatar() {
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
    const max_file_size = 1024 * 1024 // 1MB limit
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
  document.querySelectorAll('nav button').forEach(btn => {
    btn.addEventListener('click', () => show_view(btn.dataset.view))
  })
  document.addEventListener('click', (event) => {
    const target = event.target
    if (target.classList.contains('verify-btn')) {
      const entered_code = document.querySelector('.verification-input').value.trim()
      if (!entered_code || entered_code.length !== 6) {
        return alert('Please enter exactly 6 digits')
      }
      api.verify_pairing(entered_code).then((result) => {
        // Check if multiple pairing attempts were detected
        if (result && result.multiple_attempts) {
          alert(`NOTICE\n\nPairing successful, but ${result.total_attempts} device(s) attempted to pair simultaneously.\n\nThis could indicate:\n- Someone tried to steal your invite code\n- You accidentally pasted the invite on multiple devices\nIf you didn't initiate multiple pairing attempts, your invite code may have been compromised. Consider this a security warning.`)
        }
        show_view('config')
      }).catch(err => {
        alert('Verification failed: ' + err.message)
      })
    }
    if (target.classList.contains('deny-pairing-btn')) {
      api.deny_pairing()
      show_view('config')
    }
    if (target.classList.contains('subscribe-btn')) handle_subscribe(target.dataset.key)
    if (target.classList.contains('unsubscribe-btn')) handle_unsubscribe(target.dataset.key)
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
    if (event.target.classList.contains('reset-data-btn')) handle_reset_all_data()
    if (event.target.classList.contains('upload-avatar-btn')) handle_upload_avatar()
    if (target.classList.contains('show-raw-data-btn')) handle_raw_data('toggle')
    const classList = Array.from(target.classList)
    const rawBtnClass = classList.find(c => c.startsWith('raw-') && c.endsWith('-btn'))
    if (rawBtnClass) {
      const structure_name = rawBtnClass.replace('raw-', '').replace('-btn', '')
      handle_raw_data('show', structure_name)
    }
  })

  // Start app initialization
  if (username) {
    init_blog_app()
  }

},{"p2p-news-app":1}],3:[function(require,module,exports){
(function (Buffer){(function (){
function isBuffer(value) {
  return Buffer.isBuffer(value) || value instanceof Uint8Array
}

function isEncoding(encoding) {
  return Buffer.isEncoding(encoding)
}

function alloc(size, fill, encoding) {
  return Buffer.alloc(size, fill, encoding)
}

function allocUnsafe(size) {
  return Buffer.allocUnsafe(size)
}

function allocUnsafeSlow(size) {
  return Buffer.allocUnsafeSlow(size)
}

function byteLength(string, encoding) {
  return Buffer.byteLength(string, encoding)
}

function compare(a, b) {
  return Buffer.compare(a, b)
}

function concat(buffers, totalLength) {
  return Buffer.concat(buffers, totalLength)
}

function copy(source, target, targetStart, start, end) {
  return toBuffer(source).copy(target, targetStart, start, end)
}

function equals(a, b) {
  return toBuffer(a).equals(b)
}

function fill(buffer, value, offset, end, encoding) {
  return toBuffer(buffer).fill(value, offset, end, encoding)
}

function from(value, encodingOrOffset, length) {
  return Buffer.from(value, encodingOrOffset, length)
}

function includes(buffer, value, byteOffset, encoding) {
  return toBuffer(buffer).includes(value, byteOffset, encoding)
}

function indexOf(buffer, value, byfeOffset, encoding) {
  return toBuffer(buffer).indexOf(value, byfeOffset, encoding)
}

function lastIndexOf(buffer, value, byteOffset, encoding) {
  return toBuffer(buffer).lastIndexOf(value, byteOffset, encoding)
}

function swap16(buffer) {
  return toBuffer(buffer).swap16()
}

function swap32(buffer) {
  return toBuffer(buffer).swap32()
}

function swap64(buffer) {
  return toBuffer(buffer).swap64()
}

function toBuffer(buffer) {
  if (Buffer.isBuffer(buffer)) return buffer
  return Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength)
}

function toString(buffer, encoding, start, end) {
  return toBuffer(buffer).toString(encoding, start, end)
}

function write(buffer, string, offset, length, encoding) {
  return toBuffer(buffer).write(string, offset, length, encoding)
}

function readDoubleBE(buffer, offset) {
  return toBuffer(buffer).readDoubleBE(offset)
}

function readDoubleLE(buffer, offset) {
  return toBuffer(buffer).readDoubleLE(offset)
}

function readFloatBE(buffer, offset) {
  return toBuffer(buffer).readFloatBE(offset)
}

function readFloatLE(buffer, offset) {
  return toBuffer(buffer).readFloatLE(offset)
}

function readInt32BE(buffer, offset) {
  return toBuffer(buffer).readInt32BE(offset)
}

function readInt32LE(buffer, offset) {
  return toBuffer(buffer).readInt32LE(offset)
}

function readUInt32BE(buffer, offset) {
  return toBuffer(buffer).readUInt32BE(offset)
}

function readUInt32LE(buffer, offset) {
  return toBuffer(buffer).readUInt32LE(offset)
}

function writeDoubleBE(buffer, value, offset) {
  return toBuffer(buffer).writeDoubleBE(value, offset)
}

function writeDoubleLE(buffer, value, offset) {
  return toBuffer(buffer).writeDoubleLE(value, offset)
}

function writeFloatBE(buffer, value, offset) {
  return toBuffer(buffer).writeFloatBE(value, offset)
}

function writeFloatLE(buffer, value, offset) {
  return toBuffer(buffer).writeFloatLE(value, offset)
}

function writeInt32BE(buffer, value, offset) {
  return toBuffer(buffer).writeInt32BE(value, offset)
}

function writeInt32LE(buffer, value, offset) {
  return toBuffer(buffer).writeInt32LE(value, offset)
}

function writeUInt32BE(buffer, value, offset) {
  return toBuffer(buffer).writeUInt32BE(value, offset)
}

function writeUInt32LE(buffer, value, offset) {
  return toBuffer(buffer).writeUInt32LE(value, offset)
}

module.exports = {
  isBuffer,
  isEncoding,
  alloc,
  allocUnsafe,
  allocUnsafeSlow,
  byteLength,
  compare,
  concat,
  copy,
  equals,
  fill,
  from,
  includes,
  indexOf,
  lastIndexOf,
  swap16,
  swap32,
  swap64,
  toBuffer,
  toString,
  write,
  readDoubleBE,
  readDoubleLE,
  readFloatBE,
  readFloatLE,
  readInt32BE,
  readInt32LE,
  readUInt32BE,
  readUInt32LE,
  writeDoubleBE,
  writeDoubleLE,
  writeFloatBE,
  writeFloatLE,
  writeInt32BE,
  writeInt32LE,
  writeUInt32BE,
  writeUInt32LE
}

}).call(this)}).call(this,require("buffer").Buffer)
},{"buffer":5}],4:[function(require,module,exports){
'use strict'

exports.byteLength = byteLength
exports.toByteArray = toByteArray
exports.fromByteArray = fromByteArray

var lookup = []
var revLookup = []
var Arr = typeof Uint8Array !== 'undefined' ? Uint8Array : Array

var code = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
for (var i = 0, len = code.length; i < len; ++i) {
  lookup[i] = code[i]
  revLookup[code.charCodeAt(i)] = i
}

// Support decoding URL-safe base64 strings, as Node.js does.
// See: https://en.wikipedia.org/wiki/Base64#URL_applications
revLookup['-'.charCodeAt(0)] = 62
revLookup['_'.charCodeAt(0)] = 63

function getLens (b64) {
  var len = b64.length

  if (len % 4 > 0) {
    throw new Error('Invalid string. Length must be a multiple of 4')
  }

  // Trim off extra bytes after placeholder bytes are found
  // See: https://github.com/beatgammit/base64-js/issues/42
  var validLen = b64.indexOf('=')
  if (validLen === -1) validLen = len

  var placeHoldersLen = validLen === len
    ? 0
    : 4 - (validLen % 4)

  return [validLen, placeHoldersLen]
}

// base64 is 4/3 + up to two characters of the original data
function byteLength (b64) {
  var lens = getLens(b64)
  var validLen = lens[0]
  var placeHoldersLen = lens[1]
  return ((validLen + placeHoldersLen) * 3 / 4) - placeHoldersLen
}

function _byteLength (b64, validLen, placeHoldersLen) {
  return ((validLen + placeHoldersLen) * 3 / 4) - placeHoldersLen
}

function toByteArray (b64) {
  var tmp
  var lens = getLens(b64)
  var validLen = lens[0]
  var placeHoldersLen = lens[1]

  var arr = new Arr(_byteLength(b64, validLen, placeHoldersLen))

  var curByte = 0

  // if there are placeholders, only get up to the last complete 4 chars
  var len = placeHoldersLen > 0
    ? validLen - 4
    : validLen

  var i
  for (i = 0; i < len; i += 4) {
    tmp =
      (revLookup[b64.charCodeAt(i)] << 18) |
      (revLookup[b64.charCodeAt(i + 1)] << 12) |
      (revLookup[b64.charCodeAt(i + 2)] << 6) |
      revLookup[b64.charCodeAt(i + 3)]
    arr[curByte++] = (tmp >> 16) & 0xFF
    arr[curByte++] = (tmp >> 8) & 0xFF
    arr[curByte++] = tmp & 0xFF
  }

  if (placeHoldersLen === 2) {
    tmp =
      (revLookup[b64.charCodeAt(i)] << 2) |
      (revLookup[b64.charCodeAt(i + 1)] >> 4)
    arr[curByte++] = tmp & 0xFF
  }

  if (placeHoldersLen === 1) {
    tmp =
      (revLookup[b64.charCodeAt(i)] << 10) |
      (revLookup[b64.charCodeAt(i + 1)] << 4) |
      (revLookup[b64.charCodeAt(i + 2)] >> 2)
    arr[curByte++] = (tmp >> 8) & 0xFF
    arr[curByte++] = tmp & 0xFF
  }

  return arr
}

function tripletToBase64 (num) {
  return lookup[num >> 18 & 0x3F] +
    lookup[num >> 12 & 0x3F] +
    lookup[num >> 6 & 0x3F] +
    lookup[num & 0x3F]
}

function encodeChunk (uint8, start, end) {
  var tmp
  var output = []
  for (var i = start; i < end; i += 3) {
    tmp =
      ((uint8[i] << 16) & 0xFF0000) +
      ((uint8[i + 1] << 8) & 0xFF00) +
      (uint8[i + 2] & 0xFF)
    output.push(tripletToBase64(tmp))
  }
  return output.join('')
}

function fromByteArray (uint8) {
  var tmp
  var len = uint8.length
  var extraBytes = len % 3 // if we have 1 byte left, pad 2 bytes
  var parts = []
  var maxChunkLength = 16383 // must be multiple of 3

  // go through the array every three bytes, we'll deal with trailing stuff later
  for (var i = 0, len2 = len - extraBytes; i < len2; i += maxChunkLength) {
    parts.push(encodeChunk(uint8, i, (i + maxChunkLength) > len2 ? len2 : (i + maxChunkLength)))
  }

  // pad the end with zeros, but make sure to not forget the extra bytes
  if (extraBytes === 1) {
    tmp = uint8[len - 1]
    parts.push(
      lookup[tmp >> 2] +
      lookup[(tmp << 4) & 0x3F] +
      '=='
    )
  } else if (extraBytes === 2) {
    tmp = (uint8[len - 2] << 8) + uint8[len - 1]
    parts.push(
      lookup[tmp >> 10] +
      lookup[(tmp >> 4) & 0x3F] +
      lookup[(tmp << 2) & 0x3F] +
      '='
    )
  }

  return parts.join('')
}

},{}],5:[function(require,module,exports){
(function (Buffer){(function (){
/*!
 * The buffer module from node.js, for the browser.
 *
 * @author   Feross Aboukhadijeh <https://feross.org>
 * @license  MIT
 */
/* eslint-disable no-proto */

'use strict'

var base64 = require('base64-js')
var ieee754 = require('ieee754')

exports.Buffer = Buffer
exports.SlowBuffer = SlowBuffer
exports.INSPECT_MAX_BYTES = 50

var K_MAX_LENGTH = 0x7fffffff
exports.kMaxLength = K_MAX_LENGTH

/**
 * If `Buffer.TYPED_ARRAY_SUPPORT`:
 *   === true    Use Uint8Array implementation (fastest)
 *   === false   Print warning and recommend using `buffer` v4.x which has an Object
 *               implementation (most compatible, even IE6)
 *
 * Browsers that support typed arrays are IE 10+, Firefox 4+, Chrome 7+, Safari 5.1+,
 * Opera 11.6+, iOS 4.2+.
 *
 * We report that the browser does not support typed arrays if the are not subclassable
 * using __proto__. Firefox 4-29 lacks support for adding new properties to `Uint8Array`
 * (See: https://bugzilla.mozilla.org/show_bug.cgi?id=695438). IE 10 lacks support
 * for __proto__ and has a buggy typed array implementation.
 */
Buffer.TYPED_ARRAY_SUPPORT = typedArraySupport()

if (!Buffer.TYPED_ARRAY_SUPPORT && typeof console !== 'undefined' &&
    typeof console.error === 'function') {
  console.error(
    'This browser lacks typed array (Uint8Array) support which is required by ' +
    '`buffer` v5.x. Use `buffer` v4.x if you require old browser support.'
  )
}

function typedArraySupport () {
  // Can typed array instances can be augmented?
  try {
    var arr = new Uint8Array(1)
    arr.__proto__ = { __proto__: Uint8Array.prototype, foo: function () { return 42 } }
    return arr.foo() === 42
  } catch (e) {
    return false
  }
}

Object.defineProperty(Buffer.prototype, 'parent', {
  enumerable: true,
  get: function () {
    if (!Buffer.isBuffer(this)) return undefined
    return this.buffer
  }
})

Object.defineProperty(Buffer.prototype, 'offset', {
  enumerable: true,
  get: function () {
    if (!Buffer.isBuffer(this)) return undefined
    return this.byteOffset
  }
})

function createBuffer (length) {
  if (length > K_MAX_LENGTH) {
    throw new RangeError('The value "' + length + '" is invalid for option "size"')
  }
  // Return an augmented `Uint8Array` instance
  var buf = new Uint8Array(length)
  buf.__proto__ = Buffer.prototype
  return buf
}

/**
 * The Buffer constructor returns instances of `Uint8Array` that have their
 * prototype changed to `Buffer.prototype`. Furthermore, `Buffer` is a subclass of
 * `Uint8Array`, so the returned instances will have all the node `Buffer` methods
 * and the `Uint8Array` methods. Square bracket notation works as expected -- it
 * returns a single octet.
 *
 * The `Uint8Array` prototype remains unmodified.
 */

function Buffer (arg, encodingOrOffset, length) {
  // Common case.
  if (typeof arg === 'number') {
    if (typeof encodingOrOffset === 'string') {
      throw new TypeError(
        'The "string" argument must be of type string. Received type number'
      )
    }
    return allocUnsafe(arg)
  }
  return from(arg, encodingOrOffset, length)
}

// Fix subarray() in ES2016. See: https://github.com/feross/buffer/pull/97
if (typeof Symbol !== 'undefined' && Symbol.species != null &&
    Buffer[Symbol.species] === Buffer) {
  Object.defineProperty(Buffer, Symbol.species, {
    value: null,
    configurable: true,
    enumerable: false,
    writable: false
  })
}

Buffer.poolSize = 8192 // not used by this implementation

function from (value, encodingOrOffset, length) {
  if (typeof value === 'string') {
    return fromString(value, encodingOrOffset)
  }

  if (ArrayBuffer.isView(value)) {
    return fromArrayLike(value)
  }

  if (value == null) {
    throw TypeError(
      'The first argument must be one of type string, Buffer, ArrayBuffer, Array, ' +
      'or Array-like Object. Received type ' + (typeof value)
    )
  }

  if (isInstance(value, ArrayBuffer) ||
      (value && isInstance(value.buffer, ArrayBuffer))) {
    return fromArrayBuffer(value, encodingOrOffset, length)
  }

  if (typeof value === 'number') {
    throw new TypeError(
      'The "value" argument must not be of type number. Received type number'
    )
  }

  var valueOf = value.valueOf && value.valueOf()
  if (valueOf != null && valueOf !== value) {
    return Buffer.from(valueOf, encodingOrOffset, length)
  }

  var b = fromObject(value)
  if (b) return b

  if (typeof Symbol !== 'undefined' && Symbol.toPrimitive != null &&
      typeof value[Symbol.toPrimitive] === 'function') {
    return Buffer.from(
      value[Symbol.toPrimitive]('string'), encodingOrOffset, length
    )
  }

  throw new TypeError(
    'The first argument must be one of type string, Buffer, ArrayBuffer, Array, ' +
    'or Array-like Object. Received type ' + (typeof value)
  )
}

/**
 * Functionally equivalent to Buffer(arg, encoding) but throws a TypeError
 * if value is a number.
 * Buffer.from(str[, encoding])
 * Buffer.from(array)
 * Buffer.from(buffer)
 * Buffer.from(arrayBuffer[, byteOffset[, length]])
 **/
Buffer.from = function (value, encodingOrOffset, length) {
  return from(value, encodingOrOffset, length)
}

// Note: Change prototype *after* Buffer.from is defined to workaround Chrome bug:
// https://github.com/feross/buffer/pull/148
Buffer.prototype.__proto__ = Uint8Array.prototype
Buffer.__proto__ = Uint8Array

function assertSize (size) {
  if (typeof size !== 'number') {
    throw new TypeError('"size" argument must be of type number')
  } else if (size < 0) {
    throw new RangeError('The value "' + size + '" is invalid for option "size"')
  }
}

function alloc (size, fill, encoding) {
  assertSize(size)
  if (size <= 0) {
    return createBuffer(size)
  }
  if (fill !== undefined) {
    // Only pay attention to encoding if it's a string. This
    // prevents accidentally sending in a number that would
    // be interpretted as a start offset.
    return typeof encoding === 'string'
      ? createBuffer(size).fill(fill, encoding)
      : createBuffer(size).fill(fill)
  }
  return createBuffer(size)
}

/**
 * Creates a new filled Buffer instance.
 * alloc(size[, fill[, encoding]])
 **/
Buffer.alloc = function (size, fill, encoding) {
  return alloc(size, fill, encoding)
}

function allocUnsafe (size) {
  assertSize(size)
  return createBuffer(size < 0 ? 0 : checked(size) | 0)
}

/**
 * Equivalent to Buffer(num), by default creates a non-zero-filled Buffer instance.
 * */
Buffer.allocUnsafe = function (size) {
  return allocUnsafe(size)
}
/**
 * Equivalent to SlowBuffer(num), by default creates a non-zero-filled Buffer instance.
 */
Buffer.allocUnsafeSlow = function (size) {
  return allocUnsafe(size)
}

function fromString (string, encoding) {
  if (typeof encoding !== 'string' || encoding === '') {
    encoding = 'utf8'
  }

  if (!Buffer.isEncoding(encoding)) {
    throw new TypeError('Unknown encoding: ' + encoding)
  }

  var length = byteLength(string, encoding) | 0
  var buf = createBuffer(length)

  var actual = buf.write(string, encoding)

  if (actual !== length) {
    // Writing a hex string, for example, that contains invalid characters will
    // cause everything after the first invalid character to be ignored. (e.g.
    // 'abxxcd' will be treated as 'ab')
    buf = buf.slice(0, actual)
  }

  return buf
}

function fromArrayLike (array) {
  var length = array.length < 0 ? 0 : checked(array.length) | 0
  var buf = createBuffer(length)
  for (var i = 0; i < length; i += 1) {
    buf[i] = array[i] & 255
  }
  return buf
}

function fromArrayBuffer (array, byteOffset, length) {
  if (byteOffset < 0 || array.byteLength < byteOffset) {
    throw new RangeError('"offset" is outside of buffer bounds')
  }

  if (array.byteLength < byteOffset + (length || 0)) {
    throw new RangeError('"length" is outside of buffer bounds')
  }

  var buf
  if (byteOffset === undefined && length === undefined) {
    buf = new Uint8Array(array)
  } else if (length === undefined) {
    buf = new Uint8Array(array, byteOffset)
  } else {
    buf = new Uint8Array(array, byteOffset, length)
  }

  // Return an augmented `Uint8Array` instance
  buf.__proto__ = Buffer.prototype
  return buf
}

function fromObject (obj) {
  if (Buffer.isBuffer(obj)) {
    var len = checked(obj.length) | 0
    var buf = createBuffer(len)

    if (buf.length === 0) {
      return buf
    }

    obj.copy(buf, 0, 0, len)
    return buf
  }

  if (obj.length !== undefined) {
    if (typeof obj.length !== 'number' || numberIsNaN(obj.length)) {
      return createBuffer(0)
    }
    return fromArrayLike(obj)
  }

  if (obj.type === 'Buffer' && Array.isArray(obj.data)) {
    return fromArrayLike(obj.data)
  }
}

function checked (length) {
  // Note: cannot use `length < K_MAX_LENGTH` here because that fails when
  // length is NaN (which is otherwise coerced to zero.)
  if (length >= K_MAX_LENGTH) {
    throw new RangeError('Attempt to allocate Buffer larger than maximum ' +
                         'size: 0x' + K_MAX_LENGTH.toString(16) + ' bytes')
  }
  return length | 0
}

function SlowBuffer (length) {
  if (+length != length) { // eslint-disable-line eqeqeq
    length = 0
  }
  return Buffer.alloc(+length)
}

Buffer.isBuffer = function isBuffer (b) {
  return b != null && b._isBuffer === true &&
    b !== Buffer.prototype // so Buffer.isBuffer(Buffer.prototype) will be false
}

Buffer.compare = function compare (a, b) {
  if (isInstance(a, Uint8Array)) a = Buffer.from(a, a.offset, a.byteLength)
  if (isInstance(b, Uint8Array)) b = Buffer.from(b, b.offset, b.byteLength)
  if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) {
    throw new TypeError(
      'The "buf1", "buf2" arguments must be one of type Buffer or Uint8Array'
    )
  }

  if (a === b) return 0

  var x = a.length
  var y = b.length

  for (var i = 0, len = Math.min(x, y); i < len; ++i) {
    if (a[i] !== b[i]) {
      x = a[i]
      y = b[i]
      break
    }
  }

  if (x < y) return -1
  if (y < x) return 1
  return 0
}

Buffer.isEncoding = function isEncoding (encoding) {
  switch (String(encoding).toLowerCase()) {
    case 'hex':
    case 'utf8':
    case 'utf-8':
    case 'ascii':
    case 'latin1':
    case 'binary':
    case 'base64':
    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le':
      return true
    default:
      return false
  }
}

Buffer.concat = function concat (list, length) {
  if (!Array.isArray(list)) {
    throw new TypeError('"list" argument must be an Array of Buffers')
  }

  if (list.length === 0) {
    return Buffer.alloc(0)
  }

  var i
  if (length === undefined) {
    length = 0
    for (i = 0; i < list.length; ++i) {
      length += list[i].length
    }
  }

  var buffer = Buffer.allocUnsafe(length)
  var pos = 0
  for (i = 0; i < list.length; ++i) {
    var buf = list[i]
    if (isInstance(buf, Uint8Array)) {
      buf = Buffer.from(buf)
    }
    if (!Buffer.isBuffer(buf)) {
      throw new TypeError('"list" argument must be an Array of Buffers')
    }
    buf.copy(buffer, pos)
    pos += buf.length
  }
  return buffer
}

function byteLength (string, encoding) {
  if (Buffer.isBuffer(string)) {
    return string.length
  }
  if (ArrayBuffer.isView(string) || isInstance(string, ArrayBuffer)) {
    return string.byteLength
  }
  if (typeof string !== 'string') {
    throw new TypeError(
      'The "string" argument must be one of type string, Buffer, or ArrayBuffer. ' +
      'Received type ' + typeof string
    )
  }

  var len = string.length
  var mustMatch = (arguments.length > 2 && arguments[2] === true)
  if (!mustMatch && len === 0) return 0

  // Use a for loop to avoid recursion
  var loweredCase = false
  for (;;) {
    switch (encoding) {
      case 'ascii':
      case 'latin1':
      case 'binary':
        return len
      case 'utf8':
      case 'utf-8':
        return utf8ToBytes(string).length
      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return len * 2
      case 'hex':
        return len >>> 1
      case 'base64':
        return base64ToBytes(string).length
      default:
        if (loweredCase) {
          return mustMatch ? -1 : utf8ToBytes(string).length // assume utf8
        }
        encoding = ('' + encoding).toLowerCase()
        loweredCase = true
    }
  }
}
Buffer.byteLength = byteLength

function slowToString (encoding, start, end) {
  var loweredCase = false

  // No need to verify that "this.length <= MAX_UINT32" since it's a read-only
  // property of a typed array.

  // This behaves neither like String nor Uint8Array in that we set start/end
  // to their upper/lower bounds if the value passed is out of range.
  // undefined is handled specially as per ECMA-262 6th Edition,
  // Section 13.3.3.7 Runtime Semantics: KeyedBindingInitialization.
  if (start === undefined || start < 0) {
    start = 0
  }
  // Return early if start > this.length. Done here to prevent potential uint32
  // coercion fail below.
  if (start > this.length) {
    return ''
  }

  if (end === undefined || end > this.length) {
    end = this.length
  }

  if (end <= 0) {
    return ''
  }

  // Force coersion to uint32. This will also coerce falsey/NaN values to 0.
  end >>>= 0
  start >>>= 0

  if (end <= start) {
    return ''
  }

  if (!encoding) encoding = 'utf8'

  while (true) {
    switch (encoding) {
      case 'hex':
        return hexSlice(this, start, end)

      case 'utf8':
      case 'utf-8':
        return utf8Slice(this, start, end)

      case 'ascii':
        return asciiSlice(this, start, end)

      case 'latin1':
      case 'binary':
        return latin1Slice(this, start, end)

      case 'base64':
        return base64Slice(this, start, end)

      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return utf16leSlice(this, start, end)

      default:
        if (loweredCase) throw new TypeError('Unknown encoding: ' + encoding)
        encoding = (encoding + '').toLowerCase()
        loweredCase = true
    }
  }
}

// This property is used by `Buffer.isBuffer` (and the `is-buffer` npm package)
// to detect a Buffer instance. It's not possible to use `instanceof Buffer`
// reliably in a browserify context because there could be multiple different
// copies of the 'buffer' package in use. This method works even for Buffer
// instances that were created from another copy of the `buffer` package.
// See: https://github.com/feross/buffer/issues/154
Buffer.prototype._isBuffer = true

function swap (b, n, m) {
  var i = b[n]
  b[n] = b[m]
  b[m] = i
}

Buffer.prototype.swap16 = function swap16 () {
  var len = this.length
  if (len % 2 !== 0) {
    throw new RangeError('Buffer size must be a multiple of 16-bits')
  }
  for (var i = 0; i < len; i += 2) {
    swap(this, i, i + 1)
  }
  return this
}

Buffer.prototype.swap32 = function swap32 () {
  var len = this.length
  if (len % 4 !== 0) {
    throw new RangeError('Buffer size must be a multiple of 32-bits')
  }
  for (var i = 0; i < len; i += 4) {
    swap(this, i, i + 3)
    swap(this, i + 1, i + 2)
  }
  return this
}

Buffer.prototype.swap64 = function swap64 () {
  var len = this.length
  if (len % 8 !== 0) {
    throw new RangeError('Buffer size must be a multiple of 64-bits')
  }
  for (var i = 0; i < len; i += 8) {
    swap(this, i, i + 7)
    swap(this, i + 1, i + 6)
    swap(this, i + 2, i + 5)
    swap(this, i + 3, i + 4)
  }
  return this
}

Buffer.prototype.toString = function toString () {
  var length = this.length
  if (length === 0) return ''
  if (arguments.length === 0) return utf8Slice(this, 0, length)
  return slowToString.apply(this, arguments)
}

Buffer.prototype.toLocaleString = Buffer.prototype.toString

Buffer.prototype.equals = function equals (b) {
  if (!Buffer.isBuffer(b)) throw new TypeError('Argument must be a Buffer')
  if (this === b) return true
  return Buffer.compare(this, b) === 0
}

Buffer.prototype.inspect = function inspect () {
  var str = ''
  var max = exports.INSPECT_MAX_BYTES
  str = this.toString('hex', 0, max).replace(/(.{2})/g, '$1 ').trim()
  if (this.length > max) str += ' ... '
  return '<Buffer ' + str + '>'
}

Buffer.prototype.compare = function compare (target, start, end, thisStart, thisEnd) {
  if (isInstance(target, Uint8Array)) {
    target = Buffer.from(target, target.offset, target.byteLength)
  }
  if (!Buffer.isBuffer(target)) {
    throw new TypeError(
      'The "target" argument must be one of type Buffer or Uint8Array. ' +
      'Received type ' + (typeof target)
    )
  }

  if (start === undefined) {
    start = 0
  }
  if (end === undefined) {
    end = target ? target.length : 0
  }
  if (thisStart === undefined) {
    thisStart = 0
  }
  if (thisEnd === undefined) {
    thisEnd = this.length
  }

  if (start < 0 || end > target.length || thisStart < 0 || thisEnd > this.length) {
    throw new RangeError('out of range index')
  }

  if (thisStart >= thisEnd && start >= end) {
    return 0
  }
  if (thisStart >= thisEnd) {
    return -1
  }
  if (start >= end) {
    return 1
  }

  start >>>= 0
  end >>>= 0
  thisStart >>>= 0
  thisEnd >>>= 0

  if (this === target) return 0

  var x = thisEnd - thisStart
  var y = end - start
  var len = Math.min(x, y)

  var thisCopy = this.slice(thisStart, thisEnd)
  var targetCopy = target.slice(start, end)

  for (var i = 0; i < len; ++i) {
    if (thisCopy[i] !== targetCopy[i]) {
      x = thisCopy[i]
      y = targetCopy[i]
      break
    }
  }

  if (x < y) return -1
  if (y < x) return 1
  return 0
}

// Finds either the first index of `val` in `buffer` at offset >= `byteOffset`,
// OR the last index of `val` in `buffer` at offset <= `byteOffset`.
//
// Arguments:
// - buffer - a Buffer to search
// - val - a string, Buffer, or number
// - byteOffset - an index into `buffer`; will be clamped to an int32
// - encoding - an optional encoding, relevant is val is a string
// - dir - true for indexOf, false for lastIndexOf
function bidirectionalIndexOf (buffer, val, byteOffset, encoding, dir) {
  // Empty buffer means no match
  if (buffer.length === 0) return -1

  // Normalize byteOffset
  if (typeof byteOffset === 'string') {
    encoding = byteOffset
    byteOffset = 0
  } else if (byteOffset > 0x7fffffff) {
    byteOffset = 0x7fffffff
  } else if (byteOffset < -0x80000000) {
    byteOffset = -0x80000000
  }
  byteOffset = +byteOffset // Coerce to Number.
  if (numberIsNaN(byteOffset)) {
    // byteOffset: it it's undefined, null, NaN, "foo", etc, search whole buffer
    byteOffset = dir ? 0 : (buffer.length - 1)
  }

  // Normalize byteOffset: negative offsets start from the end of the buffer
  if (byteOffset < 0) byteOffset = buffer.length + byteOffset
  if (byteOffset >= buffer.length) {
    if (dir) return -1
    else byteOffset = buffer.length - 1
  } else if (byteOffset < 0) {
    if (dir) byteOffset = 0
    else return -1
  }

  // Normalize val
  if (typeof val === 'string') {
    val = Buffer.from(val, encoding)
  }

  // Finally, search either indexOf (if dir is true) or lastIndexOf
  if (Buffer.isBuffer(val)) {
    // Special case: looking for empty string/buffer always fails
    if (val.length === 0) {
      return -1
    }
    return arrayIndexOf(buffer, val, byteOffset, encoding, dir)
  } else if (typeof val === 'number') {
    val = val & 0xFF // Search for a byte value [0-255]
    if (typeof Uint8Array.prototype.indexOf === 'function') {
      if (dir) {
        return Uint8Array.prototype.indexOf.call(buffer, val, byteOffset)
      } else {
        return Uint8Array.prototype.lastIndexOf.call(buffer, val, byteOffset)
      }
    }
    return arrayIndexOf(buffer, [ val ], byteOffset, encoding, dir)
  }

  throw new TypeError('val must be string, number or Buffer')
}

function arrayIndexOf (arr, val, byteOffset, encoding, dir) {
  var indexSize = 1
  var arrLength = arr.length
  var valLength = val.length

  if (encoding !== undefined) {
    encoding = String(encoding).toLowerCase()
    if (encoding === 'ucs2' || encoding === 'ucs-2' ||
        encoding === 'utf16le' || encoding === 'utf-16le') {
      if (arr.length < 2 || val.length < 2) {
        return -1
      }
      indexSize = 2
      arrLength /= 2
      valLength /= 2
      byteOffset /= 2
    }
  }

  function read (buf, i) {
    if (indexSize === 1) {
      return buf[i]
    } else {
      return buf.readUInt16BE(i * indexSize)
    }
  }

  var i
  if (dir) {
    var foundIndex = -1
    for (i = byteOffset; i < arrLength; i++) {
      if (read(arr, i) === read(val, foundIndex === -1 ? 0 : i - foundIndex)) {
        if (foundIndex === -1) foundIndex = i
        if (i - foundIndex + 1 === valLength) return foundIndex * indexSize
      } else {
        if (foundIndex !== -1) i -= i - foundIndex
        foundIndex = -1
      }
    }
  } else {
    if (byteOffset + valLength > arrLength) byteOffset = arrLength - valLength
    for (i = byteOffset; i >= 0; i--) {
      var found = true
      for (var j = 0; j < valLength; j++) {
        if (read(arr, i + j) !== read(val, j)) {
          found = false
          break
        }
      }
      if (found) return i
    }
  }

  return -1
}

Buffer.prototype.includes = function includes (val, byteOffset, encoding) {
  return this.indexOf(val, byteOffset, encoding) !== -1
}

Buffer.prototype.indexOf = function indexOf (val, byteOffset, encoding) {
  return bidirectionalIndexOf(this, val, byteOffset, encoding, true)
}

Buffer.prototype.lastIndexOf = function lastIndexOf (val, byteOffset, encoding) {
  return bidirectionalIndexOf(this, val, byteOffset, encoding, false)
}

function hexWrite (buf, string, offset, length) {
  offset = Number(offset) || 0
  var remaining = buf.length - offset
  if (!length) {
    length = remaining
  } else {
    length = Number(length)
    if (length > remaining) {
      length = remaining
    }
  }

  var strLen = string.length

  if (length > strLen / 2) {
    length = strLen / 2
  }
  for (var i = 0; i < length; ++i) {
    var parsed = parseInt(string.substr(i * 2, 2), 16)
    if (numberIsNaN(parsed)) return i
    buf[offset + i] = parsed
  }
  return i
}

function utf8Write (buf, string, offset, length) {
  return blitBuffer(utf8ToBytes(string, buf.length - offset), buf, offset, length)
}

function asciiWrite (buf, string, offset, length) {
  return blitBuffer(asciiToBytes(string), buf, offset, length)
}

function latin1Write (buf, string, offset, length) {
  return asciiWrite(buf, string, offset, length)
}

function base64Write (buf, string, offset, length) {
  return blitBuffer(base64ToBytes(string), buf, offset, length)
}

function ucs2Write (buf, string, offset, length) {
  return blitBuffer(utf16leToBytes(string, buf.length - offset), buf, offset, length)
}

Buffer.prototype.write = function write (string, offset, length, encoding) {
  // Buffer#write(string)
  if (offset === undefined) {
    encoding = 'utf8'
    length = this.length
    offset = 0
  // Buffer#write(string, encoding)
  } else if (length === undefined && typeof offset === 'string') {
    encoding = offset
    length = this.length
    offset = 0
  // Buffer#write(string, offset[, length][, encoding])
  } else if (isFinite(offset)) {
    offset = offset >>> 0
    if (isFinite(length)) {
      length = length >>> 0
      if (encoding === undefined) encoding = 'utf8'
    } else {
      encoding = length
      length = undefined
    }
  } else {
    throw new Error(
      'Buffer.write(string, encoding, offset[, length]) is no longer supported'
    )
  }

  var remaining = this.length - offset
  if (length === undefined || length > remaining) length = remaining

  if ((string.length > 0 && (length < 0 || offset < 0)) || offset > this.length) {
    throw new RangeError('Attempt to write outside buffer bounds')
  }

  if (!encoding) encoding = 'utf8'

  var loweredCase = false
  for (;;) {
    switch (encoding) {
      case 'hex':
        return hexWrite(this, string, offset, length)

      case 'utf8':
      case 'utf-8':
        return utf8Write(this, string, offset, length)

      case 'ascii':
        return asciiWrite(this, string, offset, length)

      case 'latin1':
      case 'binary':
        return latin1Write(this, string, offset, length)

      case 'base64':
        // Warning: maxLength not taken into account in base64Write
        return base64Write(this, string, offset, length)

      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return ucs2Write(this, string, offset, length)

      default:
        if (loweredCase) throw new TypeError('Unknown encoding: ' + encoding)
        encoding = ('' + encoding).toLowerCase()
        loweredCase = true
    }
  }
}

Buffer.prototype.toJSON = function toJSON () {
  return {
    type: 'Buffer',
    data: Array.prototype.slice.call(this._arr || this, 0)
  }
}

function base64Slice (buf, start, end) {
  if (start === 0 && end === buf.length) {
    return base64.fromByteArray(buf)
  } else {
    return base64.fromByteArray(buf.slice(start, end))
  }
}

function utf8Slice (buf, start, end) {
  end = Math.min(buf.length, end)
  var res = []

  var i = start
  while (i < end) {
    var firstByte = buf[i]
    var codePoint = null
    var bytesPerSequence = (firstByte > 0xEF) ? 4
      : (firstByte > 0xDF) ? 3
        : (firstByte > 0xBF) ? 2
          : 1

    if (i + bytesPerSequence <= end) {
      var secondByte, thirdByte, fourthByte, tempCodePoint

      switch (bytesPerSequence) {
        case 1:
          if (firstByte < 0x80) {
            codePoint = firstByte
          }
          break
        case 2:
          secondByte = buf[i + 1]
          if ((secondByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0x1F) << 0x6 | (secondByte & 0x3F)
            if (tempCodePoint > 0x7F) {
              codePoint = tempCodePoint
            }
          }
          break
        case 3:
          secondByte = buf[i + 1]
          thirdByte = buf[i + 2]
          if ((secondByte & 0xC0) === 0x80 && (thirdByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0xF) << 0xC | (secondByte & 0x3F) << 0x6 | (thirdByte & 0x3F)
            if (tempCodePoint > 0x7FF && (tempCodePoint < 0xD800 || tempCodePoint > 0xDFFF)) {
              codePoint = tempCodePoint
            }
          }
          break
        case 4:
          secondByte = buf[i + 1]
          thirdByte = buf[i + 2]
          fourthByte = buf[i + 3]
          if ((secondByte & 0xC0) === 0x80 && (thirdByte & 0xC0) === 0x80 && (fourthByte & 0xC0) === 0x80) {
            tempCodePoint = (firstByte & 0xF) << 0x12 | (secondByte & 0x3F) << 0xC | (thirdByte & 0x3F) << 0x6 | (fourthByte & 0x3F)
            if (tempCodePoint > 0xFFFF && tempCodePoint < 0x110000) {
              codePoint = tempCodePoint
            }
          }
      }
    }

    if (codePoint === null) {
      // we did not generate a valid codePoint so insert a
      // replacement char (U+FFFD) and advance only 1 byte
      codePoint = 0xFFFD
      bytesPerSequence = 1
    } else if (codePoint > 0xFFFF) {
      // encode to utf16 (surrogate pair dance)
      codePoint -= 0x10000
      res.push(codePoint >>> 10 & 0x3FF | 0xD800)
      codePoint = 0xDC00 | codePoint & 0x3FF
    }

    res.push(codePoint)
    i += bytesPerSequence
  }

  return decodeCodePointsArray(res)
}

// Based on http://stackoverflow.com/a/22747272/680742, the browser with
// the lowest limit is Chrome, with 0x10000 args.
// We go 1 magnitude less, for safety
var MAX_ARGUMENTS_LENGTH = 0x1000

function decodeCodePointsArray (codePoints) {
  var len = codePoints.length
  if (len <= MAX_ARGUMENTS_LENGTH) {
    return String.fromCharCode.apply(String, codePoints) // avoid extra slice()
  }

  // Decode in chunks to avoid "call stack size exceeded".
  var res = ''
  var i = 0
  while (i < len) {
    res += String.fromCharCode.apply(
      String,
      codePoints.slice(i, i += MAX_ARGUMENTS_LENGTH)
    )
  }
  return res
}

function asciiSlice (buf, start, end) {
  var ret = ''
  end = Math.min(buf.length, end)

  for (var i = start; i < end; ++i) {
    ret += String.fromCharCode(buf[i] & 0x7F)
  }
  return ret
}

function latin1Slice (buf, start, end) {
  var ret = ''
  end = Math.min(buf.length, end)

  for (var i = start; i < end; ++i) {
    ret += String.fromCharCode(buf[i])
  }
  return ret
}

function hexSlice (buf, start, end) {
  var len = buf.length

  if (!start || start < 0) start = 0
  if (!end || end < 0 || end > len) end = len

  var out = ''
  for (var i = start; i < end; ++i) {
    out += toHex(buf[i])
  }
  return out
}

function utf16leSlice (buf, start, end) {
  var bytes = buf.slice(start, end)
  var res = ''
  for (var i = 0; i < bytes.length; i += 2) {
    res += String.fromCharCode(bytes[i] + (bytes[i + 1] * 256))
  }
  return res
}

Buffer.prototype.slice = function slice (start, end) {
  var len = this.length
  start = ~~start
  end = end === undefined ? len : ~~end

  if (start < 0) {
    start += len
    if (start < 0) start = 0
  } else if (start > len) {
    start = len
  }

  if (end < 0) {
    end += len
    if (end < 0) end = 0
  } else if (end > len) {
    end = len
  }

  if (end < start) end = start

  var newBuf = this.subarray(start, end)
  // Return an augmented `Uint8Array` instance
  newBuf.__proto__ = Buffer.prototype
  return newBuf
}

/*
 * Need to make sure that buffer isn't trying to write out of bounds.
 */
function checkOffset (offset, ext, length) {
  if ((offset % 1) !== 0 || offset < 0) throw new RangeError('offset is not uint')
  if (offset + ext > length) throw new RangeError('Trying to access beyond buffer length')
}

Buffer.prototype.readUIntLE = function readUIntLE (offset, byteLength, noAssert) {
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var val = this[offset]
  var mul = 1
  var i = 0
  while (++i < byteLength && (mul *= 0x100)) {
    val += this[offset + i] * mul
  }

  return val
}

Buffer.prototype.readUIntBE = function readUIntBE (offset, byteLength, noAssert) {
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) {
    checkOffset(offset, byteLength, this.length)
  }

  var val = this[offset + --byteLength]
  var mul = 1
  while (byteLength > 0 && (mul *= 0x100)) {
    val += this[offset + --byteLength] * mul
  }

  return val
}

Buffer.prototype.readUInt8 = function readUInt8 (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 1, this.length)
  return this[offset]
}

Buffer.prototype.readUInt16LE = function readUInt16LE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 2, this.length)
  return this[offset] | (this[offset + 1] << 8)
}

Buffer.prototype.readUInt16BE = function readUInt16BE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 2, this.length)
  return (this[offset] << 8) | this[offset + 1]
}

Buffer.prototype.readUInt32LE = function readUInt32LE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)

  return ((this[offset]) |
      (this[offset + 1] << 8) |
      (this[offset + 2] << 16)) +
      (this[offset + 3] * 0x1000000)
}

Buffer.prototype.readUInt32BE = function readUInt32BE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset] * 0x1000000) +
    ((this[offset + 1] << 16) |
    (this[offset + 2] << 8) |
    this[offset + 3])
}

Buffer.prototype.readIntLE = function readIntLE (offset, byteLength, noAssert) {
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var val = this[offset]
  var mul = 1
  var i = 0
  while (++i < byteLength && (mul *= 0x100)) {
    val += this[offset + i] * mul
  }
  mul *= 0x80

  if (val >= mul) val -= Math.pow(2, 8 * byteLength)

  return val
}

Buffer.prototype.readIntBE = function readIntBE (offset, byteLength, noAssert) {
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) checkOffset(offset, byteLength, this.length)

  var i = byteLength
  var mul = 1
  var val = this[offset + --i]
  while (i > 0 && (mul *= 0x100)) {
    val += this[offset + --i] * mul
  }
  mul *= 0x80

  if (val >= mul) val -= Math.pow(2, 8 * byteLength)

  return val
}

Buffer.prototype.readInt8 = function readInt8 (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 1, this.length)
  if (!(this[offset] & 0x80)) return (this[offset])
  return ((0xff - this[offset] + 1) * -1)
}

Buffer.prototype.readInt16LE = function readInt16LE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 2, this.length)
  var val = this[offset] | (this[offset + 1] << 8)
  return (val & 0x8000) ? val | 0xFFFF0000 : val
}

Buffer.prototype.readInt16BE = function readInt16BE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 2, this.length)
  var val = this[offset + 1] | (this[offset] << 8)
  return (val & 0x8000) ? val | 0xFFFF0000 : val
}

Buffer.prototype.readInt32LE = function readInt32LE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset]) |
    (this[offset + 1] << 8) |
    (this[offset + 2] << 16) |
    (this[offset + 3] << 24)
}

Buffer.prototype.readInt32BE = function readInt32BE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)

  return (this[offset] << 24) |
    (this[offset + 1] << 16) |
    (this[offset + 2] << 8) |
    (this[offset + 3])
}

Buffer.prototype.readFloatLE = function readFloatLE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)
  return ieee754.read(this, offset, true, 23, 4)
}

Buffer.prototype.readFloatBE = function readFloatBE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 4, this.length)
  return ieee754.read(this, offset, false, 23, 4)
}

Buffer.prototype.readDoubleLE = function readDoubleLE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 8, this.length)
  return ieee754.read(this, offset, true, 52, 8)
}

Buffer.prototype.readDoubleBE = function readDoubleBE (offset, noAssert) {
  offset = offset >>> 0
  if (!noAssert) checkOffset(offset, 8, this.length)
  return ieee754.read(this, offset, false, 52, 8)
}

function checkInt (buf, value, offset, ext, max, min) {
  if (!Buffer.isBuffer(buf)) throw new TypeError('"buffer" argument must be a Buffer instance')
  if (value > max || value < min) throw new RangeError('"value" argument is out of bounds')
  if (offset + ext > buf.length) throw new RangeError('Index out of range')
}

Buffer.prototype.writeUIntLE = function writeUIntLE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) {
    var maxBytes = Math.pow(2, 8 * byteLength) - 1
    checkInt(this, value, offset, byteLength, maxBytes, 0)
  }

  var mul = 1
  var i = 0
  this[offset] = value & 0xFF
  while (++i < byteLength && (mul *= 0x100)) {
    this[offset + i] = (value / mul) & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeUIntBE = function writeUIntBE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset >>> 0
  byteLength = byteLength >>> 0
  if (!noAssert) {
    var maxBytes = Math.pow(2, 8 * byteLength) - 1
    checkInt(this, value, offset, byteLength, maxBytes, 0)
  }

  var i = byteLength - 1
  var mul = 1
  this[offset + i] = value & 0xFF
  while (--i >= 0 && (mul *= 0x100)) {
    this[offset + i] = (value / mul) & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeUInt8 = function writeUInt8 (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 1, 0xff, 0)
  this[offset] = (value & 0xff)
  return offset + 1
}

Buffer.prototype.writeUInt16LE = function writeUInt16LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0xffff, 0)
  this[offset] = (value & 0xff)
  this[offset + 1] = (value >>> 8)
  return offset + 2
}

Buffer.prototype.writeUInt16BE = function writeUInt16BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0xffff, 0)
  this[offset] = (value >>> 8)
  this[offset + 1] = (value & 0xff)
  return offset + 2
}

Buffer.prototype.writeUInt32LE = function writeUInt32LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0xffffffff, 0)
  this[offset + 3] = (value >>> 24)
  this[offset + 2] = (value >>> 16)
  this[offset + 1] = (value >>> 8)
  this[offset] = (value & 0xff)
  return offset + 4
}

Buffer.prototype.writeUInt32BE = function writeUInt32BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0xffffffff, 0)
  this[offset] = (value >>> 24)
  this[offset + 1] = (value >>> 16)
  this[offset + 2] = (value >>> 8)
  this[offset + 3] = (value & 0xff)
  return offset + 4
}

Buffer.prototype.writeIntLE = function writeIntLE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) {
    var limit = Math.pow(2, (8 * byteLength) - 1)

    checkInt(this, value, offset, byteLength, limit - 1, -limit)
  }

  var i = 0
  var mul = 1
  var sub = 0
  this[offset] = value & 0xFF
  while (++i < byteLength && (mul *= 0x100)) {
    if (value < 0 && sub === 0 && this[offset + i - 1] !== 0) {
      sub = 1
    }
    this[offset + i] = ((value / mul) >> 0) - sub & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeIntBE = function writeIntBE (value, offset, byteLength, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) {
    var limit = Math.pow(2, (8 * byteLength) - 1)

    checkInt(this, value, offset, byteLength, limit - 1, -limit)
  }

  var i = byteLength - 1
  var mul = 1
  var sub = 0
  this[offset + i] = value & 0xFF
  while (--i >= 0 && (mul *= 0x100)) {
    if (value < 0 && sub === 0 && this[offset + i + 1] !== 0) {
      sub = 1
    }
    this[offset + i] = ((value / mul) >> 0) - sub & 0xFF
  }

  return offset + byteLength
}

Buffer.prototype.writeInt8 = function writeInt8 (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 1, 0x7f, -0x80)
  if (value < 0) value = 0xff + value + 1
  this[offset] = (value & 0xff)
  return offset + 1
}

Buffer.prototype.writeInt16LE = function writeInt16LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0x7fff, -0x8000)
  this[offset] = (value & 0xff)
  this[offset + 1] = (value >>> 8)
  return offset + 2
}

Buffer.prototype.writeInt16BE = function writeInt16BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 2, 0x7fff, -0x8000)
  this[offset] = (value >>> 8)
  this[offset + 1] = (value & 0xff)
  return offset + 2
}

Buffer.prototype.writeInt32LE = function writeInt32LE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000)
  this[offset] = (value & 0xff)
  this[offset + 1] = (value >>> 8)
  this[offset + 2] = (value >>> 16)
  this[offset + 3] = (value >>> 24)
  return offset + 4
}

Buffer.prototype.writeInt32BE = function writeInt32BE (value, offset, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000)
  if (value < 0) value = 0xffffffff + value + 1
  this[offset] = (value >>> 24)
  this[offset + 1] = (value >>> 16)
  this[offset + 2] = (value >>> 8)
  this[offset + 3] = (value & 0xff)
  return offset + 4
}

function checkIEEE754 (buf, value, offset, ext, max, min) {
  if (offset + ext > buf.length) throw new RangeError('Index out of range')
  if (offset < 0) throw new RangeError('Index out of range')
}

function writeFloat (buf, value, offset, littleEndian, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) {
    checkIEEE754(buf, value, offset, 4, 3.4028234663852886e+38, -3.4028234663852886e+38)
  }
  ieee754.write(buf, value, offset, littleEndian, 23, 4)
  return offset + 4
}

Buffer.prototype.writeFloatLE = function writeFloatLE (value, offset, noAssert) {
  return writeFloat(this, value, offset, true, noAssert)
}

Buffer.prototype.writeFloatBE = function writeFloatBE (value, offset, noAssert) {
  return writeFloat(this, value, offset, false, noAssert)
}

function writeDouble (buf, value, offset, littleEndian, noAssert) {
  value = +value
  offset = offset >>> 0
  if (!noAssert) {
    checkIEEE754(buf, value, offset, 8, 1.7976931348623157E+308, -1.7976931348623157E+308)
  }
  ieee754.write(buf, value, offset, littleEndian, 52, 8)
  return offset + 8
}

Buffer.prototype.writeDoubleLE = function writeDoubleLE (value, offset, noAssert) {
  return writeDouble(this, value, offset, true, noAssert)
}

Buffer.prototype.writeDoubleBE = function writeDoubleBE (value, offset, noAssert) {
  return writeDouble(this, value, offset, false, noAssert)
}

// copy(targetBuffer, targetStart=0, sourceStart=0, sourceEnd=buffer.length)
Buffer.prototype.copy = function copy (target, targetStart, start, end) {
  if (!Buffer.isBuffer(target)) throw new TypeError('argument should be a Buffer')
  if (!start) start = 0
  if (!end && end !== 0) end = this.length
  if (targetStart >= target.length) targetStart = target.length
  if (!targetStart) targetStart = 0
  if (end > 0 && end < start) end = start

  // Copy 0 bytes; we're done
  if (end === start) return 0
  if (target.length === 0 || this.length === 0) return 0

  // Fatal error conditions
  if (targetStart < 0) {
    throw new RangeError('targetStart out of bounds')
  }
  if (start < 0 || start >= this.length) throw new RangeError('Index out of range')
  if (end < 0) throw new RangeError('sourceEnd out of bounds')

  // Are we oob?
  if (end > this.length) end = this.length
  if (target.length - targetStart < end - start) {
    end = target.length - targetStart + start
  }

  var len = end - start

  if (this === target && typeof Uint8Array.prototype.copyWithin === 'function') {
    // Use built-in when available, missing from IE11
    this.copyWithin(targetStart, start, end)
  } else if (this === target && start < targetStart && targetStart < end) {
    // descending copy from end
    for (var i = len - 1; i >= 0; --i) {
      target[i + targetStart] = this[i + start]
    }
  } else {
    Uint8Array.prototype.set.call(
      target,
      this.subarray(start, end),
      targetStart
    )
  }

  return len
}

// Usage:
//    buffer.fill(number[, offset[, end]])
//    buffer.fill(buffer[, offset[, end]])
//    buffer.fill(string[, offset[, end]][, encoding])
Buffer.prototype.fill = function fill (val, start, end, encoding) {
  // Handle string cases:
  if (typeof val === 'string') {
    if (typeof start === 'string') {
      encoding = start
      start = 0
      end = this.length
    } else if (typeof end === 'string') {
      encoding = end
      end = this.length
    }
    if (encoding !== undefined && typeof encoding !== 'string') {
      throw new TypeError('encoding must be a string')
    }
    if (typeof encoding === 'string' && !Buffer.isEncoding(encoding)) {
      throw new TypeError('Unknown encoding: ' + encoding)
    }
    if (val.length === 1) {
      var code = val.charCodeAt(0)
      if ((encoding === 'utf8' && code < 128) ||
          encoding === 'latin1') {
        // Fast path: If `val` fits into a single byte, use that numeric value.
        val = code
      }
    }
  } else if (typeof val === 'number') {
    val = val & 255
  }

  // Invalid ranges are not set to a default, so can range check early.
  if (start < 0 || this.length < start || this.length < end) {
    throw new RangeError('Out of range index')
  }

  if (end <= start) {
    return this
  }

  start = start >>> 0
  end = end === undefined ? this.length : end >>> 0

  if (!val) val = 0

  var i
  if (typeof val === 'number') {
    for (i = start; i < end; ++i) {
      this[i] = val
    }
  } else {
    var bytes = Buffer.isBuffer(val)
      ? val
      : Buffer.from(val, encoding)
    var len = bytes.length
    if (len === 0) {
      throw new TypeError('The value "' + val +
        '" is invalid for argument "value"')
    }
    for (i = 0; i < end - start; ++i) {
      this[i + start] = bytes[i % len]
    }
  }

  return this
}

// HELPER FUNCTIONS
// ================

var INVALID_BASE64_RE = /[^+/0-9A-Za-z-_]/g

function base64clean (str) {
  // Node takes equal signs as end of the Base64 encoding
  str = str.split('=')[0]
  // Node strips out invalid characters like \n and \t from the string, base64-js does not
  str = str.trim().replace(INVALID_BASE64_RE, '')
  // Node converts strings with length < 2 to ''
  if (str.length < 2) return ''
  // Node allows for non-padded base64 strings (missing trailing ===), base64-js does not
  while (str.length % 4 !== 0) {
    str = str + '='
  }
  return str
}

function toHex (n) {
  if (n < 16) return '0' + n.toString(16)
  return n.toString(16)
}

function utf8ToBytes (string, units) {
  units = units || Infinity
  var codePoint
  var length = string.length
  var leadSurrogate = null
  var bytes = []

  for (var i = 0; i < length; ++i) {
    codePoint = string.charCodeAt(i)

    // is surrogate component
    if (codePoint > 0xD7FF && codePoint < 0xE000) {
      // last char was a lead
      if (!leadSurrogate) {
        // no lead yet
        if (codePoint > 0xDBFF) {
          // unexpected trail
          if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
          continue
        } else if (i + 1 === length) {
          // unpaired lead
          if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
          continue
        }

        // valid lead
        leadSurrogate = codePoint

        continue
      }

      // 2 leads in a row
      if (codePoint < 0xDC00) {
        if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
        leadSurrogate = codePoint
        continue
      }

      // valid surrogate pair
      codePoint = (leadSurrogate - 0xD800 << 10 | codePoint - 0xDC00) + 0x10000
    } else if (leadSurrogate) {
      // valid bmp char, but last char was a lead
      if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
    }

    leadSurrogate = null

    // encode utf8
    if (codePoint < 0x80) {
      if ((units -= 1) < 0) break
      bytes.push(codePoint)
    } else if (codePoint < 0x800) {
      if ((units -= 2) < 0) break
      bytes.push(
        codePoint >> 0x6 | 0xC0,
        codePoint & 0x3F | 0x80
      )
    } else if (codePoint < 0x10000) {
      if ((units -= 3) < 0) break
      bytes.push(
        codePoint >> 0xC | 0xE0,
        codePoint >> 0x6 & 0x3F | 0x80,
        codePoint & 0x3F | 0x80
      )
    } else if (codePoint < 0x110000) {
      if ((units -= 4) < 0) break
      bytes.push(
        codePoint >> 0x12 | 0xF0,
        codePoint >> 0xC & 0x3F | 0x80,
        codePoint >> 0x6 & 0x3F | 0x80,
        codePoint & 0x3F | 0x80
      )
    } else {
      throw new Error('Invalid code point')
    }
  }

  return bytes
}

function asciiToBytes (str) {
  var byteArray = []
  for (var i = 0; i < str.length; ++i) {
    // Node's code seems to be doing this and not & 0x7F..
    byteArray.push(str.charCodeAt(i) & 0xFF)
  }
  return byteArray
}

function utf16leToBytes (str, units) {
  var c, hi, lo
  var byteArray = []
  for (var i = 0; i < str.length; ++i) {
    if ((units -= 2) < 0) break

    c = str.charCodeAt(i)
    hi = c >> 8
    lo = c % 256
    byteArray.push(lo)
    byteArray.push(hi)
  }

  return byteArray
}

function base64ToBytes (str) {
  return base64.toByteArray(base64clean(str))
}

function blitBuffer (src, dst, offset, length) {
  for (var i = 0; i < length; ++i) {
    if ((i + offset >= dst.length) || (i >= src.length)) break
    dst[i + offset] = src[i]
  }
  return i
}

// ArrayBuffer or Uint8Array objects from other contexts (i.e. iframes) do not pass
// the `instanceof` check but they should be treated as of that type.
// See: https://github.com/feross/buffer/issues/166
function isInstance (obj, type) {
  return obj instanceof type ||
    (obj != null && obj.constructor != null && obj.constructor.name != null &&
      obj.constructor.name === type.name)
}
function numberIsNaN (obj) {
  // For IE11 support
  return obj !== obj // eslint-disable-line no-self-compare
}

}).call(this)}).call(this,require("buffer").Buffer)
},{"base64-js":4,"buffer":5,"ieee754":6}],6:[function(require,module,exports){
/*! ieee754. BSD-3-Clause License. Feross Aboukhadijeh <https://feross.org/opensource> */
exports.read = function (buffer, offset, isLE, mLen, nBytes) {
  var e, m
  var eLen = (nBytes * 8) - mLen - 1
  var eMax = (1 << eLen) - 1
  var eBias = eMax >> 1
  var nBits = -7
  var i = isLE ? (nBytes - 1) : 0
  var d = isLE ? -1 : 1
  var s = buffer[offset + i]

  i += d

  e = s & ((1 << (-nBits)) - 1)
  s >>= (-nBits)
  nBits += eLen
  for (; nBits > 0; e = (e * 256) + buffer[offset + i], i += d, nBits -= 8) {}

  m = e & ((1 << (-nBits)) - 1)
  e >>= (-nBits)
  nBits += mLen
  for (; nBits > 0; m = (m * 256) + buffer[offset + i], i += d, nBits -= 8) {}

  if (e === 0) {
    e = 1 - eBias
  } else if (e === eMax) {
    return m ? NaN : ((s ? -1 : 1) * Infinity)
  } else {
    m = m + Math.pow(2, mLen)
    e = e - eBias
  }
  return (s ? -1 : 1) * m * Math.pow(2, e - mLen)
}

exports.write = function (buffer, value, offset, isLE, mLen, nBytes) {
  var e, m, c
  var eLen = (nBytes * 8) - mLen - 1
  var eMax = (1 << eLen) - 1
  var eBias = eMax >> 1
  var rt = (mLen === 23 ? Math.pow(2, -24) - Math.pow(2, -77) : 0)
  var i = isLE ? 0 : (nBytes - 1)
  var d = isLE ? 1 : -1
  var s = value < 0 || (value === 0 && 1 / value < 0) ? 1 : 0

  value = Math.abs(value)

  if (isNaN(value) || value === Infinity) {
    m = isNaN(value) ? 1 : 0
    e = eMax
  } else {
    e = Math.floor(Math.log(value) / Math.LN2)
    if (value * (c = Math.pow(2, -e)) < 1) {
      e--
      c *= 2
    }
    if (e + eBias >= 1) {
      value += rt / c
    } else {
      value += rt * Math.pow(2, 1 - eBias)
    }
    if (value * c >= 2) {
      e++
      c /= 2
    }

    if (e + eBias >= eMax) {
      m = 0
      e = eMax
    } else if (e + eBias >= 1) {
      m = ((value * c) - 1) * Math.pow(2, mLen)
      e = e + eBias
    } else {
      m = value * Math.pow(2, eBias - 1) * Math.pow(2, mLen)
      e = 0
    }
  }

  for (; mLen >= 8; buffer[offset + i] = m & 0xff, i += d, m /= 256, mLen -= 8) {}

  e = (e << mLen) | m
  eLen += mLen
  for (; eLen > 0; buffer[offset + i] = e & 0xff, i += d, e /= 256, eLen -= 8) {}

  buffer[offset + i - d] |= s * 128
}

},{}]},{},[2]);
