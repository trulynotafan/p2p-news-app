(function(){function r(e,n,t){function o(i,f){if(!n[i]){if(!e[i]){var c="function"==typeof require&&require;if(!f&&c)return c(i,!0);if(u)return u(i,!0);var a=new Error("Cannot find module '"+i+"'");throw a.code="MODULE_NOT_FOUND",a}var p=n[i]={exports:{}};e[i][0].call(p.exports,function(r){var n=e[i][1][r];return o(n||r)},p,p.exports,r,e,n,t)}return n[i].exports}for(var u="function"==typeof require&&require,i=0;i<t.length;i++)o(t[i]);return o}return r})()({1:[function(require,module,exports){
(function (Buffer){(function (){
// P2P News App.. Blog application that receives identity (vault) as parameter
// Exports a single constructor function named blog_app
const b4a = require('b4a')

// Blog-specific topic for swarm discovery
const BLOG_TOPIC = b4a.from('ffb09601562034ee8394ab609322173b641ded168059d256f6a3d959b2dc6021', 'hex')

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
  // ADD NEW STRUCTURES, Just one line. Example:
  // { name: 'comments', namespace: 'blog-comments', type: 'autodrive' }
]
// ============================================================================

// Emitter
const make_emitter = (state = {}) => ({
  on: (type, cb) => (state[type] = state[type] || []).push(cb),
  off: (type, cb) => (state[type] = state[type] || [])[state[type].indexOf(cb)] = undefined,
  emit: (type, data) => (state[type] = state[type] || []).map(f => f && f(data))
})

// Global state
let store, ds_manager, pairing_manager, pairing_result = null
const discovered_blogs = new Map()
const peer_relays = new Map() // Store relay URLs for peers
const autobase_cache = new Map()
const drive_cache = new Map()
const emitter = make_emitter()

// Validation
const validate_blog_init = (entry) => {
  const { type, data = {} } = entry || {}
  return type === 'blog-init' &&
         typeof data.username === 'string' &&
         typeof data.title === 'string' &&
         typeof data.drive_key === 'string'
}

const validate_blog_post = (entry) => {
  const { type, data = {} } = entry || {}
  return type === 'blog-post' &&
         typeof data.filepath === 'string' &&
         typeof data.created === 'number'
}

// LocalStorage helpers
const get_subscribed_peers = () => {
  try { return JSON.parse(localStorage.getItem('subscribed_peers') || '[]') } catch { return [] }
}

const add_subscribed_peer = (key) => {
  const peers = get_subscribed_peers()
  if (!peers.includes(key)) {
    peers.push(key)
    localStorage.setItem('subscribed_peers', JSON.stringify(peers))
  }
}

const remove_subscribed_peer = (key) => {
  localStorage.setItem('subscribed_peers', JSON.stringify(
    get_subscribed_peers().filter(k => k !== key)
  ))
}

// Store relay URL for a peer (called from protocol exchange)
const set_peer_relay = (key, relay_url) => {
  if (relay_url) peer_relays.set(key, relay_url)
}

// Setup peer autobase
const setup_peer_autobase = async (key, key_buffer) => {
  // Check if already exists
  if (autobase_cache.has(key)) return autobase_cache.get(key)
  
  // Use datastructure-manager to create peer metadata autobase
  const peer_autobase = await ds_manager.create_peer_structure('metadata', key, key_buffer, store)

  // Wait for data if empty
  if (peer_autobase.view.length === 0) {
    await new Promise(resolve => peer_autobase.once('update', resolve))
  }

  const handle_peer_autobase_update = async () => {
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
  console.log('[setup_peer_autobase] Setup complete')
  return peer_autobase
}

// Restore subscribed peers
const restore_subscribed_peers = () => {
  if (!store) return
  
  const handle_peer_key = async (key) => {
    try {
      const key_buffer = b4a.from(key, 'hex')
      await setup_peer_autobase(key, key_buffer)
    } catch (err) {
      console.error('Error restoring peer:', err)
    }
  }
  
  get_subscribed_peers().forEach(handle_peer_key)
}

// Initialize blog
const init_blog = async (options) => {
  const { username, invite_code, verification_code, relay, offline_mode } = options
  
  const peer_name = invite_code ? 'joining-user' : username
  const networking_options = {
    name: peer_name,
    store_name: `blogs-${peer_name}`,
    topic: BLOG_TOPIC,
    get_primary_key: () => ds_manager ? ds_manager.get_key('metadata') : null,
    get_primary_structure: () => ds_manager ? ds_manager.get('metadata') : null,
    relay,
    offline_mode
  }
  
  const { store: _store, swarm: _swarm, dht, cleanup } = await identity.start_networking(networking_options)
  
  store = _store
  const swarm_instance = _swarm
  
  // Set swarm in identity for app access
  identity.set_swarm(swarm_instance)
  
  // Create datastructure manager from identity
  ds_manager = identity.create_ds_manager()
  
  // Set ds_manager in identity for dynamic raw data access
  identity.set_ds_manager(ds_manager)
  
  // Register all structures 
  for (const config of STRUCTURES) {
    ds_manager.register({ ...config, store })
  }

  // JOINING EXISTING BLOG - All keys received from pairing
  if (invite_code) {
    // join_with_invite_and_init already initializes ALL structures with keys from pairing
    const result = await ds_manager.join_with_invite_and_init(invite_code, swarm_instance, store, verification_code)
    console.log('[blog-helpers] Pairing result:', result)
    pairing_result = result  // Store for later retrieval
    console.log('[blog-helpers] Pairing result stored, username:', pairing_result?.username)
    
    const metadata = ds_manager.get('metadata')
    const drive = ds_manager.get('drive')
    const profile_drive = ds_manager.get('profile')
    const events_drive = ds_manager.get('events')
    
    // Wait for all structures to be ready
    await Promise.all([
      metadata.ready(),
      drive.ready(),
      profile_drive.ready(),
      events_drive.ready()
    ])
    
    // Download content
    await metadata.update()
    await drive.download('/')
    await profile_drive.download('/')
    
    // Setup identity events drive (for device management only)
    identity.set_events_drive(events_drive, ds_manager.get_store('events'))
    
    // Setup event handlers
    store.on('peer-autobase-key', async ({ key, key_buffer, relay_url }) => {
      if (key === ds_manager.get_key('metadata')) return
      if (relay_url) set_peer_relay(key, relay_url)
      if (autobase_cache.has(key)) return
      await setup_peer_autobase(key, key_buffer)
    })

    metadata.on('update', () => emitter.emit('update'))
    restore_subscribed_peers()
    
    return { store, swarm: swarm_instance }
  }
  
  // CREATING NEW BLOG - using the ds_manager
  const instances = await ds_manager.init_all()
  const metadata = instances.metadata
  
  // Write blog initialization entry
  await metadata.append({
    type: 'blog-init',
    data: {
      username,
      title: `${username}'s Blog`,
      drive_key: ds_manager.get_key('drive')
    }
  })
  
  // Setup identity (profile and events already initialized by init_all)
  const profile_drive = instances.profile
  const events_drive = instances.events
  
  await profile_drive.ready()
  await events_drive.ready()
  
  // Setup identity events drive (for device management only)
  identity.set_events_drive(events_drive, ds_manager.get_store('events'))
  
  await create_default_profile(username)
  
  // Log bootstrap device with ALL structure writer keys (also dynamic)
  const device_keys = {}
  for (const name of ds_manager.get_names()) {
    const structure = ds_manager.get(name)
    const config = ds_manager.get_config(name)
    
    let writer_key = null
    if (config.type === 'autobase') {
      // For autobase: structure.local.key
      writer_key = structure.local?.key
    } else if (config.type === 'autodrive') {
      // For autodrive: structure.base.local.key
      writer_key = structure.base?.local?.key
    }
    
    if (writer_key) {
      device_keys[`${name}_writer`] = b4a.toString(writer_key, 'hex')
    } else {
      console.warn(`[blog-helpers] No writer key found for structure: ${name}`)
    }
  }
  
  // Device keys initialized
  
  // Only log device if it doesn't already exist (prevent duplicates on refresh)
  const existing_devices = await get_paired_devices()
  const device_exists = existing_devices.some(d => d.metadata_writer === device_keys.metadata_writer)
  
  if (!device_exists) {
    await log_event('add', device_keys)
    console.log('[blog-helpers] Bootstrap device logged')
  } else {
    console.log('[blog-helpers] Bootstrap device already exists, skipping log')
  }
  
  // Write ALL structure keys to metadata (dynamic!)
  const all_structure_keys = {}
  for (const name of ds_manager.get_names()) {
    // Skip metadata and drive (already shared via pairing)
    if (name !== 'metadata' && name !== 'drive') {
      all_structure_keys[`${name}_key`] = ds_manager.get_key(name)
    }
  }
  
  await metadata.append({
    type: 'blog-init-extended',
    data: all_structure_keys
  })

  // Setup event handlers
  store.on('peer-autobase-key', async ({ key, key_buffer, relay_url }) => {
    if (key === ds_manager.get_key('metadata')) return
    if (relay_url) set_peer_relay(key, relay_url)
    if (autobase_cache.has(key)) return
    await setup_peer_autobase(key, key_buffer)
  })

  metadata.on('update', () => emitter.emit('update'))
  
  restore_subscribed_peers()
  
  return { store, swarm: swarm_instance }
}

// Create post
const create_post = async (title, content) => {
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
}

// Profile management (app-specific, not in identity)
const create_default_profile = async (username) => {
  const profile_drive = ds_manager.get('profile')
  const default_avatar = `<svg><text x="50%" y="50%" font-size="120" text-anchor="middle" dominant-baseline="middle">👤</text></svg>`
  
  await profile_drive.put('/avatar.svg', b4a.from(default_avatar))
  await profile_drive.put('/profile.json', b4a.from(JSON.stringify({
    name: username,
    avatar: '/avatar.svg'
  })))
}

const upload_avatar = async (imageData, filename) => {
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
  emitter.emit('update')
}

const get_profile = async (profile_key = null) => {
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

const get_avatar_content = async (profile_key = null) => {
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
const log_event = async (type, data) => {
  const events_drive = ds_manager.get('events')
  return identity.log_event(events_drive, type, data)
}

const get_paired_devices = async () => {
  const events_drive = ds_manager.get('events')
  return identity.get_paired_devices(events_drive)
}

const remove_device = async (device) => {
  const events_drive = ds_manager.get('events')
  return identity.remove_device(events_drive, device)
}

const get_raw_data = async (structure_name) => {
  return identity.get_raw_data(structure_name)
}

// Subscribe to peer
const subscribe = async (key) => {
  if (!key || typeof key !== 'string') return false
  
  const my_key = ds_manager.get_key('metadata')
  if (key === my_key) return false
  
  try {
    const key_buffer = b4a.from(key, 'hex')
    await setup_peer_autobase(key, key_buffer)
    add_subscribed_peer(key)
    emitter.emit('update')
    return true
  } catch (err) {
    console.error('Subscribe error:', err)
    return false
  }
}

// Unsubscribe
const unsubscribe = async (key) => {
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
  
  // Keep in discovered_blogs so it shows in "Discovered Peers" again
  emitter.emit('update')
}

// Get blog username
const get_blog_username = async () => {
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
const get_blog_drive_key = async (key_name) => {
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

const get_blog_profile_drive_key = () => get_blog_drive_key('profile_drive_key')
const get_blog_events_drive_key = () => get_blog_drive_key('events_drive_key')

// Get posts
const get_posts = async (key = null) => {
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

const get_my_posts = () => get_posts()

// Get peer blogs
const get_peer_blogs = async () => {
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

// Create invite - Use universal API
const create_invite = async () => {
  const swarm = identity.get_swarm()
  const drive = ds_manager.get('drive')
  
  const { invite_code, invite, verification_code, pairing_manager: pm } = await ds_manager.create_invite_with_pairing(swarm, 'drive')
  
  // Store pairing_manager for later use
  if (!pairing_manager) pairing_manager = pm
  
  // Get username from profile (using blog app's get_profile, not identity)
  const profile = await get_profile()
  const blog_username = profile?.name || 'Unknown'
  
  // Setup member to handle pairing requests
  await pm.setup_member({
    primary_discovery_key: drive.base.discoveryKey,
    invite,
    username: blog_username,
    on_paired: async (writer_keys) => {
      // Convert writer_keys from namespace format to structure_name_writer format
      const device_keys = {}
      for (const name of ds_manager.get_names()) {
        const config = ds_manager.get_config(name)
        if (writer_keys[config.namespace]) {
          device_keys[`${name}_writer`] = writer_keys[config.namespace]
        }
      }
      
      // Log device add event with proper format
      await log_event('add', device_keys)
      
      // Clear verification code after successful pairing
      if (pairing_manager) pairing_manager.clear_verification_code()
    }
  })
  
  return { invite_code, verification_code }
}

// Getters
const get_drive = () => ds_manager ? ds_manager.get('drive') : null
const get_profile_drive = () => ds_manager ? ds_manager.get('profile') : null
const get_autobase_key = () => ds_manager ? ds_manager.get_key('metadata') : null
const get_autobase = () => ds_manager ? ds_manager.get('metadata') : null
const get_metadata_store = () => ds_manager ? ds_manager.get_store('metadata') : null
const get_drive_store = () => ds_manager ? ds_manager.get_store('drive') : null
const get_profile_store = () => ds_manager ? ds_manager.get_store('profile') : null
const get_events_store = () => ds_manager ? ds_manager.get_store('events') : null
const get_local_key = () => {
  const metadata = ds_manager.get('metadata')
  return metadata ? b4a.toString(metadata.local.key, 'hex') : null
}
const get_discovered_blogs = () => discovered_blogs
const get_pairing_result = () => pairing_result
const get_structure_names = () => ds_manager ? ds_manager.get_names() : []

  // Return the blog app API
  const api = {
    init_blog,
    create_post,
    create_invite,
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
    get_pairing_result,
    get_structure_names,
    on_update: (cb) => emitter.on('update', cb)
  }
  
  return api
}
}).call(this)}).call(this,require("buffer").Buffer)
},{"b4a":2,"buffer":5}],2:[function(require,module,exports){
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
},{"buffer":5}],3:[function(require,module,exports){
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

},{}],4:[function(require,module,exports){

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
},{"base64-js":3,"buffer":5,"ieee754":7}],6:[function(require,module,exports){
(function (__filename){(function (){
const STATE = require('STATE')
const statedb = STATE(__filename)
const { get } = statedb(fallback_module)

module.exports = graph_explorer

async function graph_explorer (opts, protocol) {
  /******************************************************************************
  COMPONENT INITIALIZATION
    - This sets up the initial state, variables, and the basic DOM structure.
    - It also initializes the IntersectionObserver for virtual scrolling and
      sets up the watcher for state changes.
  ******************************************************************************/
  const { sdb } = await get(opts.sid)
  const { drive } = sdb

  let vertical_scroll_value = 0
  let horizontal_scroll_value = 0
  let selected_instance_paths = []
  let confirmed_instance_paths = []
  let db = null // Database for entries
  let instance_states = {} // Holds expansion state {expanded_subs, expanded_hubs} for each node instance.
  let search_state_instances = {}
  let search_entry_states = {} // Holds expansion state for search mode interactions separately
  let view = [] // A flat array representing the visible nodes in the graph.
  let mode // Current mode of the graph explorer, can be set to 'default', 'menubar' or 'search'. Its value should be set by the `mode` file in the drive.
  let previous_mode
  let search_query = ''
  let hubs_flag = 'default' // Flag for hubs behavior: 'default' (prevent duplication), 'true' (no duplication prevention), 'false' (disable hubs)
  let selection_flag = 'default' // Flag for selection behavior: 'default' (enable selection), 'false' (disable selection)
  let recursive_collapse_flag = false // Flag for recursive collapse: true (recursive), false (parent level only)
  let drive_updated_by_scroll = false // Flag to prevent `onbatch` from re-rendering on scroll updates.
  let drive_updated_by_toggle = false // Flag to prevent `onbatch` from re-rendering on toggle updates.
  let drive_updated_by_search = false // Flag to prevent `onbatch` from re-rendering on search updates.
  let drive_updated_by_last_clicked = false // Flag to prevent `onbatch` from re-rendering on last clicked node updates.
  let ignore_drive_updated_by_scroll = false // Prevent scroll flag.
  let drive_updated_by_match = false // Flag to prevent `onbatch` from re-rendering on matching entry updates.
  let drive_updated_by_tracking = false // Flag to prevent `onbatch` from re-rendering on view order tracking updates.
  let drive_updated_by_undo = false // Flag to prevent onbatch from re-rendering on undo updates
  let is_loading_from_drive = false // Flag to prevent saving to drive during initial load
  let multi_select_enabled = false // Flag to enable multi-select mode without ctrl key
  let select_between_enabled = false // Flag to enable select between mode
  let select_between_first_node = null // First node selected in select between mode
  let duplicate_entries_map = {}
  let view_order_tracking = {} // Tracks instance paths by base path in real time as they are added into the view through toggle expand/collapse actions.
  let is_rendering = false // Flag to prevent concurrent rendering operations in virtual scrolling.
  let spacer_element = null // DOM element used to manage scroll position when hubs are toggled.
  let spacer_initial_height = 0
  let hub_num = 0 // Counter for expanded hubs.
  let last_clicked_node = null // Track the last clicked node instance path for highlighting.
  let root_wand_state = null // Store original root wand state when replaced with jump button
  const manipulated_inside_search = {}
  let keybinds = {} // Store keyboard navigation bindings
  let undo_stack = [] // Stack to track drive state changes for undo functionality

  // Protocol system for message-based communication
  let send = null
  let graph_explorer_mid = 0 // Message ID counter for graph_explorer.js -> page.js messages
  if (protocol) {
    send = protocol(msg => onmessage(msg))
  }

  // Create db object that communicates via protocol messages
  db = create_db()

  const el = document.createElement('div')
  el.className = 'graph-explorer-wrapper'
  const shadow = el.attachShadow({ mode: 'closed' })
  shadow.innerHTML = `
    <div class="graph-container"></div>
    <div class="searchbar"></div>
    <div class="menubar"></div>
  `
  const searchbar = shadow.querySelector('.searchbar')
  const menubar = shadow.querySelector('.menubar')
  const container = shadow.querySelector('.graph-container')

  document.body.style.margin = 0

  let scroll_update_pending = false
  container.onscroll = onscroll

  let start_index = 0
  let end_index = 0
  const chunk_size = 50
  const max_rendered_nodes = chunk_size * 3
  let node_height

  const top_sentinel = document.createElement('div')
  const bottom_sentinel = document.createElement('div')

  const observer = new IntersectionObserver(handle_sentinel_intersection, {
    root: container,
    rootMargin: '500px 0px',
    threshold: 0
  })

  // Define handlers for different data types from the drive, called by `onbatch`.
  const on = {
    style: inject_style,
    runtime: on_runtime,
    mode: on_mode,
    flags: on_flags,
    keybinds: on_keybinds,
    undo: on_undo
  }
  // Start watching for state changes. This is the main trigger for all updates.
  await sdb.watch(onbatch)

  document.onkeydown = handle_keyboard_navigation

  return el

  /******************************************************************************
  ESSAGE HANDLING
    - Handles incoming messages and sends outgoing messages.
    - Messages follow standardized format: { head: [by, to, mid], refs, type, data }
  ******************************************************************************/
  function onmessage (msg) {
    const { type, data } = msg
    const on_message_types = {
      set_mode: handle_set_mode,
      set_search_query: handle_set_search_query,
      select_nodes: handle_select_nodes,
      expand_node: handle_expand_node,
      collapse_node: handle_collapse_node,
      toggle_node: handle_toggle_node,
      get_selected: handle_get_selected,
      get_confirmed: handle_get_confirmed,
      clear_selection: handle_clear_selection,
      set_flag: handle_set_flag,
      scroll_to_node: handle_scroll_to_node,
      db_response: handle_db_response,
      db_initialized: handle_db_initialized
    }

    const handler = on_message_types[type]
    if (handler) handler(data)
    else console.warn(`[graph_explorer-protocol] Unknown message type: ${type}`, msg)

    function handle_db_response () {
      db.handle_response(msg)
    }

    function handle_set_mode (data) {
      const { mode: new_mode } = data
      if (new_mode && ['default', 'menubar', 'search'].includes(new_mode)) {
        update_drive_state({ type: 'mode/current_mode', message: new_mode })
        send_message({ type: 'mode_changed', data: { mode: new_mode } })
      }
    }

    function handle_set_search_query (data) {
      const { query } = data
      if (typeof query === 'string') {
        search_query = query
        drive_updated_by_search = true
        update_drive_state({ type: 'mode/search_query', message: query })
        if (mode === 'search') perform_search(query)
        send_message({ type: 'search_query_changed', data: { query } })
      }
    }

    function handle_select_nodes (data) {
      const { instance_paths } = data
      if (Array.isArray(instance_paths)) {
        update_drive_state({ type: 'runtime/selected_instance_paths', message: instance_paths })
        send_message({ type: 'selection_changed', data: { selected: instance_paths } })
      }
    }

    function handle_expand_node (data) {
      const { instance_path, expand_subs = true, expand_hubs = false } = data
      if (instance_path && instance_states[instance_path]) {
        instance_states[instance_path].expanded_subs = expand_subs
        instance_states[instance_path].expanded_hubs = expand_hubs
        drive_updated_by_toggle = true
        update_drive_state({ type: 'runtime/instance_states', message: instance_states })
        send_message({ type: 'node_expanded', data: { instance_path, expand_subs, expand_hubs } })
      }
    }

    function handle_collapse_node (data) {
      const { instance_path } = data
      if (instance_path && instance_states[instance_path]) {
        instance_states[instance_path].expanded_subs = false
        instance_states[instance_path].expanded_hubs = false
        drive_updated_by_toggle = true
        update_drive_state({ type: 'runtime/instance_states', message: instance_states })
        send_message({ type: 'node_collapsed', data: { instance_path } })
      }
    }

    async function handle_toggle_node (data) {
      const { instance_path, toggle_type = 'subs' } = data
      if (instance_path && instance_states[instance_path]) {
        if (toggle_type === 'subs') {
          await toggle_subs(instance_path)
        } else if (toggle_type === 'hubs') {
          await toggle_hubs(instance_path)
        }
        send_message({ type: 'node_toggled', data: { instance_path, toggle_type } })
      }
    }

    function handle_get_selected (data) {
      send_message({ type: 'selected_nodes', data: { selected: selected_instance_paths } })
    }

    function handle_get_confirmed (data) {
      send_message({ type: 'confirmed_nodes', data: { confirmed: confirmed_instance_paths } })
    }

    function handle_clear_selection (data) {
      update_drive_state({ type: 'runtime/selected_instance_paths', message: [] })
      update_drive_state({ type: 'runtime/confirmed_selected', message: [] })
      send_message({ type: 'selection_cleared', data: {} })
    }

    function handle_set_flag (data) {
      const { flag_type, value } = data
      if (flag_type === 'hubs' && ['default', 'true', 'false'].includes(value)) {
        update_drive_state({ type: 'flags/hubs', message: value })
      } else if (flag_type === 'selection') {
        update_drive_state({ type: 'flags/selection', message: value })
      } else if (flag_type === 'recursive_collapse') {
        update_drive_state({ type: 'flags/recursive_collapse', message: value })
      }
      send_message({ type: 'flag_changed', data: { flag_type, value } })
    }

    function handle_scroll_to_node (data) {
      const { instance_path } = data
      const node_index = view.findIndex(n => n.instance_path === instance_path)
      if (node_index !== -1) {
        const scroll_position = node_index * node_height
        container.scrollTop = scroll_position
        send_message({ type: 'scrolled_to_node', data: { instance_path, scroll_position } })
      }
    }
  }
  async function handle_db_initialized (data) {
    // Page.js, trigger initial render
    // After receiving entries, ensure the root node state is initialized and trigger the first render.
    const root_path = '/'
    if (await db.has(root_path)) {
      const root_instance_path = '|/'
      if (!instance_states[root_instance_path]) {
        instance_states[root_instance_path] = {
          expanded_subs: true,
          expanded_hubs: false
        }
      }
      // don't rebuild view if we're in search mode with active query
      if (mode === 'search' && search_query) {
        console.log('[SEARCH DEBUG] on_entries: skipping build_and_render_view in Search Mode with query:', search_query)
        perform_search(search_query)
      } else {
        // tracking will be initialized later if drive data is empty
        build_and_render_view()
      }
    } else {
      console.warn('Root path "/" not found in entries. Clearing view.')
      view = []
      if (container) container.replaceChildren()
    }
  }
  function send_message (msg) {
    if (send) {
      send(msg)
    }
  }

  function create_db () {
    // Pending requests map: key is message head [by, to, mid], value is {resolve, reject}
    const pending_requests = new Map()

    return {
      // All operations are async via protocol messages
      get: (path) => send_db_request('db_get', { path }),
      has: (path) => send_db_request('db_has', { path }),
      is_empty: () => send_db_request('db_is_empty', {}),
      root: () => send_db_request('db_root', {}),
      keys: () => send_db_request('db_keys', {}),
      raw: () => send_db_request('db_raw', {}),
      // Handle responses from page.js
      handle_response: (msg) => {
        if (!msg.refs || !msg.refs.cause) {
          console.warn('[graph_explorer] Response missing refs.cause:', msg)
          return
        }
        const request_head_key = JSON.stringify(msg.refs.cause)
        const pending = pending_requests.get(request_head_key)
        if (pending) {
          pending.resolve(msg.data.result)
          pending_requests.delete(request_head_key)
        } else {
          console.warn('[graph_explorer] No pending request for response:', msg.refs.cause)
        }
      }
    }

    function send_db_request (operation, params) {
      return new Promise((resolve, reject) => {
        const head = ['graph_explorer', 'page_js', graph_explorer_mid++]
        const head_key = JSON.stringify(head)
        pending_requests.set(head_key, { resolve, reject })

        send_message({
          head,
          refs: null, // New request has no references
          type: operation,
          data: params
        })
      })
    }
  }

  /******************************************************************************
  STATE AND DATA HANDLING
    - These functions process incoming data from the STATE module's `sdb.watch`.
    - `onbatch` is the primary entry point.
  ******************************************************************************/
  async function onbatch (batch) {
    console.log('[SEARCH DEBUG] onbatch caled:', {
      mode,
      search_query,
      last_clicked_node,
      feedback_flags: {
        scroll: drive_updated_by_scroll,
        toggle: drive_updated_by_toggle,
        search: drive_updated_by_search,
        match: drive_updated_by_match,
        tracking: drive_updated_by_tracking
      }
    })

    // Prevent feedback loops from scroll or toggle actions.
    if (check_and_reset_feedback_flags()) {
      console.log('[SEARCH DEBUG] onbatch prevented by feedback flags')
      return
    }

    for (const { type, paths } of batch) {
      if (!paths || !paths.length) continue
      const data = await Promise.all(
        paths.map(path => batch_get(path))
      )
      // Call the appropriate handler based on `type`.
      const func = on[type]
      func ? await func({ data, paths }) : fail(data, type)
    }

    function batch_get (path) {
      return drive
        .get(path)
        .then(file => (file ? file.raw : null))
        .catch(e => {
          console.error(`Error getting file from drive: ${path}`, e)
          return null
        })
    }
  }

  function fail (data, type) {
    throw new Error(`Invalid message type: ${type}`, { cause: { data, type } })
  }

  async function on_runtime ({ data, paths }) {
    const on_runtime_paths = {
      'node_height.json': handle_node_height,
      'vertical_scroll_value.json': handle_vertical_scroll,
      'horizontal_scroll_value.json': handle_horizontal_scroll,
      'selected_instance_paths.json': handle_selected_paths,
      'confirmed_selected.json': handle_confirmed_paths,
      'instance_states.json': handle_instance_states,
      'search_entry_states.json': handle_search_entry_states,
      'last_clicked_node.json': handle_last_clicked_node,
      'view_order_tracking.json': handle_view_order_tracking
    }
    let needs_render = false
    const render_nodes_needed = new Set()

    paths.forEach((path, i) => runtime_handler(path, data[i]))

    if (needs_render) {
      if (mode === 'search' && search_query) {
        console.log('[SEARCH DEBUG] on_runtime: Skipping build_and_render_view in search mode with query:', search_query)
        await perform_search(search_query)
      } else {
        await build_and_render_view()
      }
    } else if (render_nodes_needed.size > 0) {
      render_nodes_needed.forEach(re_render_node)
    }

    function runtime_handler (path, data) {
      if (data === null) return
      const value = parse_json_data(data, path)
      if (value === null) return

      // Extract filename from path and use handler if available
      const filename = path.split('/').pop()
      const handler = on_runtime_paths[filename]
      if (handler) {
        const result = handler({ value, render_nodes_needed })
        if (result?.needs_render) needs_render = true
      }
    }

    function handle_node_height ({ value }) {
      node_height = value
    }

    function handle_vertical_scroll ({ value }) {
      if (typeof value === 'number') vertical_scroll_value = value
    }

    function handle_horizontal_scroll ({ value }) {
      if (typeof value === 'number') horizontal_scroll_value = value
    }

    function handle_selected_paths ({ value, render_nodes_needed }) {
      selected_instance_paths = process_path_array_update({
        current_paths: selected_instance_paths,
        value,
        render_set: render_nodes_needed,
        name: 'selected_instance_paths'
      })
    }

    function handle_confirmed_paths ({ value, render_nodes_needed }) {
      confirmed_instance_paths = process_path_array_update({
        current_paths: confirmed_instance_paths,
        value,
        render_set: render_nodes_needed,
        name: 'confirmed_selected'
      })
    }

    function handle_instance_states ({ value }) {
      if (typeof value === 'object' && value && !Array.isArray(value)) {
        instance_states = value
        return { needs_render: true }
      } else {
        console.warn('instance_states is not a valid object, ignoring.', value)
      }
    }

    function handle_search_entry_states ({ value }) {
      if (typeof value === 'object' && value && !Array.isArray(value)) {
        search_entry_states = value
        if (mode === 'search') return { needs_render: true }
      } else {
        console.warn('search_entry_states is not a valid object, ignoring.', value)
      }
    }

    function handle_last_clicked_node ({ value, render_nodes_needed }) {
      const old_last_clicked = last_clicked_node
      last_clicked_node = typeof value === 'string' ? value : null
      if (old_last_clicked) render_nodes_needed.add(old_last_clicked)
      if (last_clicked_node) render_nodes_needed.add(last_clicked_node)
    }

    function handle_view_order_tracking ({ value }) {
      if (typeof value === 'object' && value && !Array.isArray(value)) {
        is_loading_from_drive = true
        view_order_tracking = value
        is_loading_from_drive = false
        if (Object.keys(view_order_tracking).length === 0) {
          initialize_tracking_from_current_state()
        }
        return { needs_render: true }
      } else {
        console.warn('view_order_tracking is not a valid object, ignoring.', value)
      }
    }
  }

  async function on_mode ({ data, paths }) {
    const on_mode_paths = {
      'current_mode.json': handle_current_mode,
      'previous_mode.json': handle_previous_mode,
      'search_query.json': handle_search_query,
      'multi_select_enabled.json': handle_multi_select_enabled,
      'select_between_enabled.json': handle_select_between_enabled
    }
    let new_current_mode, new_previous_mode, new_search_query, new_multi_select_enabled, new_select_between_enabled

    paths.forEach((path, i) => mode_handler(path, data[i]))

    if (typeof new_search_query === 'string') search_query = new_search_query
    if (new_previous_mode) previous_mode = new_previous_mode
    if (typeof new_multi_select_enabled === 'boolean') {
      multi_select_enabled = new_multi_select_enabled
      render_menubar() // Re-render menubar to update button text
    }
    if (typeof new_select_between_enabled === 'boolean') {
      select_between_enabled = new_select_between_enabled
      if (!select_between_enabled) select_between_first_node = null
      render_menubar()
    }

    if (
      new_current_mode &&
      !['default', 'menubar', 'search'].includes(new_current_mode)
    ) {
      console.warn(`Invalid mode "${new_current_mode}" provided. Ignoring update.`)
      return
    }

    if (new_current_mode === 'search' && !search_query) {
      search_state_instances = instance_states
    }
    if (!new_current_mode || mode === new_current_mode) return

    if (mode && new_current_mode === 'search') update_drive_state({ type: 'mode/previous_mode', message: mode })
    mode = new_current_mode
    render_menubar()
    render_searchbar()
    await handle_mode_change()
    if (mode === 'search' && search_query) await perform_search(search_query)

    function mode_handler (path, data) {
      const value = parse_json_data(data, path)
      if (value === null) return

      const filename = path.split('/').pop()
      const handler = on_mode_paths[filename]
      if (handler) {
        const result = handler({ value })
        if (result?.current_mode !== undefined) new_current_mode = result.current_mode
        if (result?.previous_mode !== undefined) new_previous_mode = result.previous_mode
        if (result?.search_query !== undefined) new_search_query = result.search_query
        if (result?.multi_select_enabled !== undefined) new_multi_select_enabled = result.multi_select_enabled
        if (result?.select_between_enabled !== undefined) new_select_between_enabled = result.select_between_enabled
      }
    }
    function handle_current_mode ({ value }) {
      return { current_mode: value }
    }

    function handle_previous_mode ({ value }) {
      return { previous_mode: value }
    }

    function handle_search_query ({ value }) {
      return { search_query: value }
    }

    function handle_multi_select_enabled ({ value }) {
      return { multi_select_enabled: value }
    }

    function handle_select_between_enabled ({ value }) {
      return { select_between_enabled: value }
    }
  }

  function on_flags ({ data, paths }) {
    const on_flags_paths = {
      'hubs.json': handle_hubs_flag,
      'selection.json': handle_selection_flag,
      'recursive_collapse.json': handle_recursive_collapse_flag
    }

    paths.forEach((path, i) => flags_handler(path, data[i]))

    function flags_handler (path, data) {
      const value = parse_json_data(data, path)
      if (value === null) return

      const filename = path.split('/').pop()
      const handler = on_flags_paths[filename]
      if (handler) {
        const result = handler(value)
        if (result && result.needs_render) {
          if (mode === 'search' && search_query) {
            console.log('[SEARCH DEBUG] on_flags: Skipping build_and_render_view in search mode with query:', search_query)
            perform_search(search_query)
          } else {
            build_and_render_view()
          }
        }
      }
    }

    function handle_hubs_flag (value) {
      if (typeof value === 'string' && ['default', 'true', 'false'].includes(value)) {
        hubs_flag = value
        return { needs_render: true }
      } else {
        console.warn('hubs flag must be one of: "default", "true", "false", ignoring.', value)
      }
    }

    function handle_selection_flag (value) {
      selection_flag = value
      return { needs_render: true }
    }

    function handle_recursive_collapse_flag (value) {
      recursive_collapse_flag = value
      return { needs_render: false }
    }
  }

  function inject_style ({ data }) {
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(data[0])
    shadow.adoptedStyleSheets = [sheet]
  }

  function on_keybinds ({ data }) {
    if (!data || data[0] == null) {
      console.error('Keybinds data is missing or empty.')
      return
    }
    const parsed_data = parse_json_data(data[0])
    if (typeof parsed_data !== 'object' || !parsed_data) {
      console.error('Parsed keybinds data is not a valid object.')
      return
    }
    keybinds = parsed_data
  }

  function on_undo ({ data }) {
    if (!data || data[0] == null) {
      console.error('Undo stack data is missing or empty.')
      return
    }
    const parsed_data = parse_json_data(data[0])
    if (!Array.isArray(parsed_data)) {
      console.error('Parsed undo stack data is not a valid array.')
      return
    }
    undo_stack = parsed_data
  }

  // Helper to persist component state to the drive.
  async function update_drive_state ({ type, message }) {
    // Save current state to undo stack before updating (except for some)
    const should_track = (
      !drive_updated_by_undo &&
      !type.includes('scroll') &&
      !type.includes('last_clicked') &&
      !type.includes('view_order_tracking') &&
      !type.includes('select_between') &&
      type !== 'undo/stack'
    )
    if (should_track) {
      await save_to_undo_stack(type)
    }

    try {
      await drive.put(`${type}.json`, JSON.stringify(message))
    } catch (e) {
      const [dataset, name] = type.split('/')
      console.error(`Failed to update ${dataset} state for ${name}:`, e)
    }
    if (should_track) {
      render_menubar()
    }
  }

  async function save_to_undo_stack (type) {
    try {
      const current_file = await drive.get(`${type}.json`)
      if (current_file && current_file.raw) {
        const snapshot = {
          type,
          value: current_file.raw,
          timestamp: Date.now()
        }

        // Add to stack (limit to 50 items to prevent memory issues)
        undo_stack.push(snapshot)
        if (undo_stack.length > 50) {
          undo_stack.shift()
        }
        drive_updated_by_undo = true
        await drive.put('undo/stack.json', JSON.stringify(undo_stack))
      }
    } catch (e) {
      console.error('Failed to save to undo stack:', e)
    }
  }

  function get_or_create_state (states, instance_path) {
    if (!states[instance_path]) {
      states[instance_path] = { expanded_subs: false, expanded_hubs: false }
    }
    if (states[instance_path].expanded_subs === null) {
      states[instance_path].expanded_subs = true
    }

    return states[instance_path]
  }

  async function calculate_children_pipe_trail ({
    depth,
    is_hub,
    is_last_sub,
    is_first_hub = false,
    parent_pipe_trail,
    parent_base_path,
    base_path,
    db
  }) {
    const children_pipe_trail = [...parent_pipe_trail]
    const parent_entry = await db.get(parent_base_path)
    const is_hub_on_top = base_path === parent_entry?.hubs?.[0] || base_path === '/'

    if (depth > 0) {
      if (is_hub) {
        if (is_last_sub) {
          children_pipe_trail.pop()
          children_pipe_trail.push(true)
        }
        if (is_hub_on_top && !is_last_sub) {
          children_pipe_trail.pop()
          children_pipe_trail.push(true)
        }
        if (is_first_hub) {
          children_pipe_trail.pop()
          children_pipe_trail.push(false)
        }
      }
      children_pipe_trail.push(is_hub || !is_last_sub)
    }
    return { children_pipe_trail, is_hub_on_top }
  }

  // Extracted pipe logic for reuse in both default and search modes
  async function calculate_pipe_trail ({
    depth,
    is_hub,
    is_last_sub,
    is_first_hub = false,
    is_hub_on_top,
    parent_pipe_trail,
    parent_base_path,
    base_path,
    db
  }) {
    let last_pipe = null
    const parent_entry = await db.get(parent_base_path)
    const calculated_is_hub_on_top = base_path === parent_entry?.hubs?.[0] || base_path === '/'
    const final_is_hub_on_top = is_hub_on_top !== undefined ? is_hub_on_top : calculated_is_hub_on_top

    if (depth > 0) {
      if (is_hub) {
        last_pipe = [...parent_pipe_trail]
        if (is_last_sub) {
          last_pipe.pop()
          last_pipe.push(true)
          if (is_first_hub) {
            last_pipe.pop()
            last_pipe.push(false)
          }
        }
        if (final_is_hub_on_top && !is_last_sub) {
          last_pipe.pop()
          last_pipe.push(true)
        }
      }
    }

    const pipe_trail = (is_hub && is_last_sub) || (is_hub && final_is_hub_on_top) ? last_pipe : parent_pipe_trail
    const product = { pipe_trail, is_hub_on_top: final_is_hub_on_top }
    return product
  }

  /******************************************************************************
  VIEW AND RENDERING LOGIC AND SCALING
    - These functions build the `view` array and render the DOM.
    - `build_and_render_view` is the main orchestrator.
    - `build_view_recursive` creates the flat `view` array from the hierarchical data.
    - `calculate_mobile_scale` calculates the scale factor for mobile devices.
  ******************************************************************************/
  async function build_and_render_view (focal_instance_path, hub_toggle = false) {
    console.log('[SEARCH DEBUG] build_and_render_view called:', {
      focal_instance_path,
      hub_toggle,
      current_mode: mode,
      search_query,
      last_clicked_node,
      stack_trace: new Error().stack.split('\n').slice(1, 4).map(line => line.trim())
    })

    // This fuction should'nt be called in search mode for search
    if (mode === 'search' && search_query && !hub_toggle) {
      console.error('[SEARCH DEBUG] build_and_render_view called inappropriately in search mode!', {
        mode,
        search_query,
        focal_instance_path,
        stack_trace: new Error().stack.split('\n').slice(1, 6).map(line => line.trim())
      })
    }

    const is_empty = await db.is_empty()
    if (!db || is_empty) {
      console.warn('No entries available to render.')
      return
    }

    const old_view = [...view]
    const old_scroll_top = vertical_scroll_value
    const old_scroll_left = horizontal_scroll_value
    let existing_spacer_height = 0
    if (spacer_element && spacer_element.parentNode) existing_spacer_height = parseFloat(spacer_element.style.height) || 0

    // Recursively build the new `view` array from the graph data.
    view = await build_view_recursive({
      base_path: '/',
      parent_instance_path: '',
      depth: 0,
      is_last_sub: true,
      is_hub: false,
      parent_pipe_trail: [],
      instance_states,
      db
    })

    // Recalculate duplicates after view is built
    collect_all_duplicate_entries()

    const new_scroll_top = calculate_new_scroll_top({
      old_scroll_top,
      old_view,
      focal_path: focal_instance_path
    })
    const render_anchor_index = Math.max(0, Math.floor(new_scroll_top / node_height))
    start_index = Math.max(0, render_anchor_index - chunk_size)
    end_index = Math.min(view.length, render_anchor_index + chunk_size)

    const fragment = document.createDocumentFragment()
    for (let i = start_index; i < end_index; i++) {
      if (view[i]) fragment.appendChild(create_node(view[i]))
    }

    container.replaceChildren(top_sentinel, fragment, bottom_sentinel)
    top_sentinel.style.height = `${start_index * node_height}px`
    bottom_sentinel.style.height = `${(view.length - end_index) * node_height}px`

    observer.observe(top_sentinel)
    observer.observe(bottom_sentinel)

    // Handle the spacer element used for keep entries static wrt cursor by scrolling when hubs are toggled.
    handle_spacer_element({
      hub_toggle,
      existing_height: existing_spacer_height,
      new_scroll_top,
      sync_fn: set_scroll_and_sync
    })

    function set_scroll_and_sync () {
      drive_updated_by_scroll = true
      container.scrollTop = new_scroll_top
      container.scrollLeft = old_scroll_left
      vertical_scroll_value = container.scrollTop
    }
  }

  // Traverses the hierarchical entries data and builds a flat `view` array for rendering.
  async function build_view_recursive ({
    base_path,
    parent_instance_path,
    parent_base_path = null,
    depth,
    is_last_sub,
    is_hub,
    is_first_hub = false,
    parent_pipe_trail,
    instance_states,
    db
  }) {
    const instance_path = `${parent_instance_path}|${base_path}`
    const entry = await db.get(base_path)
    if (!entry) return []

    const state = get_or_create_state(instance_states, instance_path)

    const { children_pipe_trail, is_hub_on_top } = await calculate_children_pipe_trail({
      depth,
      is_hub,
      is_last_sub,
      is_first_hub,
      parent_pipe_trail,
      parent_base_path,
      base_path,
      db
    })

    const current_view = []
    // If hubs are expanded, recursively add them to the view first (they appear above the node).
    if (state.expanded_hubs && Array.isArray(entry.hubs)) {
      for (let i = 0; i < entry.hubs.length; i++) {
        const hub_path = entry.hubs[i]
        const hub_view = await build_view_recursive({
          base_path: hub_path,
          parent_instance_path: instance_path,
          parent_base_path: base_path,
          depth: depth + 1,
          is_last_sub: i === entry.hubs.length - 1,
          is_hub: true,
          is_first_hub: is_hub ? is_hub_on_top : false,
          parent_pipe_trail: children_pipe_trail,
          instance_states,
          db
        })
        current_view.push(...hub_view)
      }
    }

    // Calculate pipe_trail for this node
    const { pipe_trail, is_hub_on_top: calculated_is_hub_on_top } = await calculate_pipe_trail({
      depth,
      is_hub,
      is_last_sub,
      is_first_hub,
      is_hub_on_top,
      parent_pipe_trail,
      parent_base_path,
      base_path,
      db
    })

    current_view.push({
      base_path,
      instance_path,
      depth,
      is_last_sub,
      is_hub,
      is_first_hub,
      parent_pipe_trail,
      parent_base_path,
      entry, // Include entry data in view to avoid async lookups during rendering
      pipe_trail, // Pre-calculated pipe trail
      is_hub_on_top: calculated_is_hub_on_top // Pre-calculated hub position
    })

    // If subs are expanded, recursively add them to the view (they appear below the node).
    if (state.expanded_subs && Array.isArray(entry.subs)) {
      for (let i = 0; i < entry.subs.length; i++) {
        const sub_path = entry.subs[i]
        const sub_view = await build_view_recursive({
          base_path: sub_path,
          parent_instance_path: instance_path,
          parent_base_path: base_path,
          depth: depth + 1,
          is_last_sub: i === entry.subs.length - 1,
          is_hub: false,
          parent_pipe_trail: children_pipe_trail,
          instance_states,
          db
        })
        current_view.push(...sub_view)
      }
    }
    return current_view
  }

  /******************************************************************************
 4. NODE CREATION AND EVENT HANDLING
   - `create_node` generates the DOM element for a single node.
   - It sets up event handlers for user interactions like selecting or toggling.
  ******************************************************************************/

  function create_node ({
    base_path,
    instance_path,
    depth,
    is_last_sub,
    is_hub,
    is_search_match,
    is_direct_match,
    is_in_original_view,
    query,
    entry, // Entry data is now passed from view
    pipe_trail, // Pre-calculated pipe trail
    is_hub_on_top // Pre-calculated hub position
  }) {
    if (!entry) {
      const err_el = document.createElement('div')
      err_el.className = 'node error'
      err_el.textContent = `Error: Missing entry for ${base_path}`
      return err_el
    }

    let states
    if (mode === 'search') {
      if (manipulated_inside_search[instance_path]) {
        search_entry_states[instance_path] = manipulated_inside_search[instance_path]
        states = search_entry_states
      } else {
        states = search_state_instances
      }
    } else {
      states = instance_states
    }
    const state = get_or_create_state(states, instance_path)

    const el = document.createElement('div')
    el.className = `node type-${entry.type || 'unknown'}`
    el.dataset.instance_path = instance_path
    if (is_search_match) {
      el.classList.add('search-result')
      if (is_direct_match) el.classList.add('direct-match')
      if (!is_in_original_view) el.classList.add('new-entry')
    }

    if (selected_instance_paths.includes(instance_path)) el.classList.add('selected')
    if (confirmed_instance_paths.includes(instance_path)) el.classList.add('confirmed')
    if (last_clicked_node === instance_path) {
      mode === 'search' ? el.classList.add('search-last-clicked') : el.classList.add('last-clicked')
    }

    const has_hubs = hubs_flag === 'false' ? false : Array.isArray(entry.hubs) && entry.hubs.length > 0
    const has_subs = Array.isArray(entry.subs) && entry.subs.length > 0

    if (depth) {
      el.classList.add('left-indent')
    }

    if (base_path === '/' && instance_path === '|/') return create_root_node({ state, has_subs, instance_path })
    const prefix_class_name = get_prefix({ is_last_sub, has_subs, state, is_hub, is_hub_on_top })
    // Use pre-calculated pipe_trail
    const pipe_html = pipe_trail.map(p => `<span class="${p ? 'pipe' : 'blank'}"></span>`).join('')
    const prefix_class = has_subs ? 'prefix clickable' : 'prefix'
    const icon_class = has_hubs && base_path !== '/' ? 'icon clickable' : 'icon'
    const entry_name = entry.name || base_path
    const name_html = (is_direct_match && query)
      ? get_highlighted_name(entry_name, query)
      : entry_name

    // Check if this entry appears elsewhere in the view (any duplicate)
    let has_duplicate_entries = false
    let is_first_occurrence = false
    if (hubs_flag !== 'true') {
      has_duplicate_entries = has_duplicates(base_path)

      // coloring class for duplicates
      if (has_duplicate_entries) {
        is_first_occurrence = is_first_duplicate(base_path, instance_path)
        if (is_first_occurrence) {
          el.classList.add('first-matching-entry')
        } else {
          el.classList.add('matching-entry')
        }
      }
    }

    el.innerHTML = `
      <span class="indent">${pipe_html}</span>
      <span class="${prefix_class} ${prefix_class_name}"></span>
      <span class="${icon_class}"></span>
      <span class="name ${has_duplicate_entries && !is_first_occurrence ? '' : 'clickable'}">${name_html}</span>
    `

    // For matching entries, disable normal event listener and add handler to whole entry to create button for jump to next duplicate
    if (has_duplicate_entries && !is_first_occurrence && hubs_flag !== 'true') {
      el.onclick = jump_out_to_next_duplicate
    } else {
      const icon_el = el.querySelector('.icon')
      if (icon_el && has_hubs && base_path !== '/') {
        icon_el.onclick = (mode === 'search' && search_query)
          ? () => toggle_search_hubs(instance_path)
          : () => toggle_hubs(instance_path)
      }

      // Add click event to the whole first part (indent + prefix) for expanding/collapsing subs
      if (has_subs) {
        const indent_el = el.querySelector('.indent')
        const prefix_el = el.querySelector('.prefix')

        const toggle_subs_handler = (mode === 'search' && search_query)
          ? () => toggle_search_subs(instance_path)
          : () => toggle_subs(instance_path)

        if (indent_el) indent_el.onclick = toggle_subs_handler
        if (prefix_el) prefix_el.onclick = toggle_subs_handler
      }

      // Special handling for first duplicate entry - it should have normal select behavior but also show jump button
      const name_el = el.querySelector('.name')
      if (selection_flag !== false) {
        if (has_duplicate_entries && is_first_occurrence && hubs_flag !== 'true') {
          name_el.onclick = ev => jump_and_select_matching_entry(ev, instance_path)
        } else {
          name_el.onclick = ev => mode === 'search' ? handle_search_name_click(ev, instance_path) : select_node(ev, instance_path)
        }
      } else {
        name_el.onclick = () => handle_last_clicked_node(instance_path)
      }

      function handle_last_clicked_node (instance_path) {
        last_clicked_node = instance_path
        drive_updated_by_last_clicked = true
        update_drive_state({ type: 'runtime/last_clicked_node', message: instance_path })
        update_last_clicked_styling(instance_path)
      }
    }

    if (selected_instance_paths.includes(instance_path) || confirmed_instance_paths.includes(instance_path)) el.appendChild(create_confirm_checkbox(instance_path))

    return el
    function jump_and_select_matching_entry (ev, instance_path) {
      if (mode === 'search') {
        handle_search_name_click(ev, instance_path)
      } else {
        select_node(ev, instance_path)
      }
      // Also add jump button functionality for first occurrence
      setTimeout(() => add_jump_button_to_matching_entry(el, base_path, instance_path), 10)
    }
    function jump_out_to_next_duplicate () {
      last_clicked_node = instance_path
      drive_updated_by_match = true
      update_drive_state({ type: 'runtime/last_clicked_node', message: instance_path })
      update_last_clicked_styling(instance_path)
      add_jump_button_to_matching_entry(el, base_path, instance_path)
    }
  }

  // `re_render_node` updates a single node in the DOM, used when only its selection state changes.
  function re_render_node (instance_path) {
    const node_data = view.find(n => n.instance_path === instance_path)
    if (node_data) {
      const old_node_el = shadow.querySelector(`[data-instance_path="${CSS.escape(instance_path)}"]`)
      if (old_node_el) old_node_el.replaceWith(create_node(node_data))
    }
  }

  // `get_prefix` determines which box-drawing character to use for the node's prefix. It gives the name of a specific CSS class.
  function get_prefix ({ is_last_sub, has_subs, state, is_hub, is_hub_on_top }) {
    if (!state) {
      console.error('get_prefix called with invalid state.')
      return 'middle-line'
    }

    // Define handlers for different prefix types based on node position
    const on_prefix_types = {
      hub_on_top: get_hub_on_top_prefix,
      hub_not_on_top: get_hub_not_on_top_prefix,
      last_sub: get_last_sub_prefix,
      middle_sub: get_middle_sub_prefix
    }
    // Determine the prefix type based on node position
    let prefix_type
    if (is_hub && is_hub_on_top) prefix_type = 'hub_on_top'
    else if (is_hub && !is_hub_on_top) prefix_type = 'hub_not_on_top'
    else if (is_last_sub) prefix_type = 'last_sub'
    else prefix_type = 'middle_sub'

    const handler = on_prefix_types[prefix_type]

    return handler ? handler({ state, has_subs }) : 'middle-line'

    function get_hub_on_top_prefix ({ state }) {
      const { expanded_subs, expanded_hubs } = state
      if (expanded_subs && expanded_hubs) return 'top-cross'
      if (expanded_subs) return 'top-tee-down'
      if (expanded_hubs) return 'top-tee-up'
      return 'top-line'
    }

    function get_hub_not_on_top_prefix ({ state }) {
      const { expanded_subs, expanded_hubs } = state
      if (expanded_subs && expanded_hubs) return 'middle-cross'
      if (expanded_subs) return 'middle-tee-down'
      if (expanded_hubs) return 'middle-tee-up'
      return 'middle-line'
    }

    function get_last_sub_prefix ({ state, has_subs }) {
      const { expanded_subs, expanded_hubs } = state
      if (expanded_subs && expanded_hubs) return 'bottom-cross'
      if (expanded_subs) return 'bottom-tee-down'
      if (expanded_hubs) return has_subs ? 'bottom-tee-up' : 'bottom-light-tee-up'
      return has_subs ? 'bottom-line' : 'bottom-light-line'
    }

    function get_middle_sub_prefix ({ state, has_subs }) {
      const { expanded_subs, expanded_hubs } = state
      if (expanded_subs && expanded_hubs) return 'middle-cross'
      if (expanded_subs) return 'middle-tee-down'
      if (expanded_hubs) return has_subs ? 'middle-tee-up' : 'middle-light-tee-up'
      return has_subs ? 'middle-line' : 'middle-light-line'
    }
  }

  /******************************************************************************
  MENUBAR AND SEARCH
  ******************************************************************************/
  function render_menubar () {
    const search_button = document.createElement('button')
    search_button.textContent = 'Search'
    search_button.onclick = toggle_search_mode

    const undo_button = document.createElement('button')
    undo_button.textContent = `Undo (${undo_stack.length})`
    undo_button.onclick = () => undo(1)
    undo_button.disabled = undo_stack.length === 0

    const multi_select_button = document.createElement('button')
    multi_select_button.textContent = `Multi Select: ${multi_select_enabled}`
    multi_select_button.onclick = toggle_multi_select

    const select_between_button = document.createElement('button')
    select_between_button.textContent = `Select Between: ${select_between_enabled}`
    select_between_button.onclick = toggle_select_between

    const hubs_button = document.createElement('button')
    hubs_button.textContent = `Hubs: ${hubs_flag}`
    hubs_button.onclick = toggle_hubs_flag

    const selection_button = document.createElement('button')
    selection_button.textContent = `Selection: ${selection_flag}`
    selection_button.onclick = toggle_selection_flag

    const recursive_collapse_button = document.createElement('button')
    recursive_collapse_button.textContent = `Recursive Collapse: ${recursive_collapse_flag}`
    recursive_collapse_button.onclick = toggle_recursive_collapse_flag

    menubar.replaceChildren(search_button, undo_button, multi_select_button, select_between_button, hubs_button, selection_button, recursive_collapse_button)
  }

  function render_searchbar () {
    if (mode !== 'search') {
      searchbar.style.display = 'none'
      searchbar.replaceChildren()
      return
    }

    const search_opts = {
      type: 'text',
      placeholder: 'Search entries...',
      className: 'search-input',
      value: search_query,
      oninput: on_search_input
    }
    searchbar.style.display = 'flex'
    const search_input = Object.assign(document.createElement('input'), search_opts)

    searchbar.replaceChildren(search_input)
    requestAnimationFrame(() => search_input.focus())
  }

  async function handle_mode_change () {
    menubar.style.display = mode === 'default' ? 'none' : 'flex'
    render_searchbar()
    await build_and_render_view()
  }

  async function toggle_search_mode () {
    const target_mode = mode === 'search' ? previous_mode : 'search'
    console.log('[SEARCH DEBUG] Switching mode from', mode, 'to', target_mode)
    send_message({ type: 'mode_toggling', data: { from: mode, to: target_mode } })
    if (mode === 'search') {
      // When switching from search to default mode, expand selected entries
      if (selected_instance_paths.length > 0) {
        console.log('[SEARCH DEBUG] Expanding selected entries in default mode:', selected_instance_paths)
        await expand_selected_entries_in_default(selected_instance_paths)
        drive_updated_by_toggle = true
        update_drive_state({ type: 'runtime/instance_states', message: instance_states })
      }
      // Reset select-between mode when leaving search mode
      if (select_between_enabled) {
        select_between_enabled = false
        select_between_first_node = null
        update_drive_state({ type: 'mode/select_between_enabled', message: false })
        console.log('[SEARCH DEBUG] Reset select-between mode when leaving search')
      }
      search_query = ''
      update_drive_state({ type: 'mode/search_query', message: '' })
    }
    ignore_drive_updated_by_scroll = true
    update_drive_state({ type: 'mode/current_mode', message: target_mode })
    search_state_instances = instance_states
    send_message({ type: 'mode_changed', data: { mode: target_mode } })
  }

  function toggle_multi_select () {
    multi_select_enabled = !multi_select_enabled
    // Disable select between when enabling multi select
    if (multi_select_enabled && select_between_enabled) {
      select_between_enabled = false
      select_between_first_node = null
      update_drive_state({ type: 'mode/select_between_enabled', message: false })
    }
    update_drive_state({ type: 'mode/multi_select_enabled', message: multi_select_enabled })
    render_menubar() // Re-render to update button text
  }

  function toggle_select_between () {
    select_between_enabled = !select_between_enabled
    select_between_first_node = null // Reset first node selection
    // Disable multi select when enabling select between
    if (select_between_enabled && multi_select_enabled) {
      multi_select_enabled = false
      update_drive_state({ type: 'mode/multi_select_enabled', message: false })
    }
    update_drive_state({ type: 'mode/select_between_enabled', message: select_between_enabled })
    render_menubar() // Re-render to update button text
  }

  function toggle_hubs_flag () {
    const values = ['default', 'true', 'false']
    const current_index = values.indexOf(hubs_flag)
    const next_index = (current_index + 1) % values.length
    hubs_flag = values[next_index]
    update_drive_state({ type: 'flags/hubs', message: hubs_flag })
    render_menubar()
  }

  function toggle_selection_flag () {
    selection_flag = !selection_flag
    update_drive_state({ type: 'flags/selection', message: selection_flag })
    render_menubar()
  }

  function toggle_recursive_collapse_flag () {
    recursive_collapse_flag = !recursive_collapse_flag
    update_drive_state({ type: 'flags/recursive_collapse', message: recursive_collapse_flag })
    render_menubar()
  }

  function on_search_input (event) {
    search_query = event.target.value.trim()
    drive_updated_by_search = true
    update_drive_state({ type: 'mode/search_query', message: search_query })
    if (search_query === '') search_state_instances = instance_states
    perform_search(search_query)
  }

  async function perform_search (query) {
    console.log('[SEARCH DEBUG] perform_search called:', {
      query,
      current_mode: mode,
      search_query_var: search_query,
      has_search_entry_states: Object.keys(search_entry_states).length > 0,
      last_clicked_node
    })
    if (!query) {
      console.log('[SEARCH DEBUG] No query provided, building default view')
      return build_and_render_view()
    }

    const original_view = await build_view_recursive({
      base_path: '/',
      parent_instance_path: '',
      depth: 0,
      is_last_sub: true,
      is_hub: false,
      parent_pipe_trail: [],
      instance_states,
      db
    })
    const original_view_paths = original_view.map(n => n.instance_path)
    search_state_instances = {}
    const search_tracking = {}
    const search_view = await build_search_view_recursive({
      query,
      base_path: '/',
      parent_instance_path: '',
      depth: 0,
      is_last_sub: true,
      is_hub: false,
      is_first_hub: false,
      parent_pipe_trail: [],
      instance_states: search_state_instances,
      db,
      original_view_paths,
      is_expanded_child: false,
      search_tracking
    })
    console.log('[SEARCH DEBUG] Search view built:', search_view.length)
    render_search_results(search_view, query)
  }

  async function build_search_view_recursive ({
    query,
    base_path,
    parent_instance_path,
    parent_base_path = null,
    depth,
    is_last_sub,
    is_hub,
    is_first_hub = false,
    parent_pipe_trail,
    instance_states,
    db,
    original_view_paths,
    is_expanded_child = false,
    search_tracking = {}
  }) {
    const entry = await db.get(base_path)
    if (!entry) return []

    const instance_path = `${parent_instance_path}|${base_path}`
    const is_direct_match = entry.name && entry.name.toLowerCase().includes(query.toLowerCase())

    // track instance for duplicate detection
    if (!search_tracking[base_path]) search_tracking[base_path] = []
    const is_first_occurrence_in_search = !search_tracking[base_path].length
    search_tracking[base_path].push(instance_path)

    // Use extracted pipe logic for consistent rendering
    const { children_pipe_trail, is_hub_on_top } = await calculate_children_pipe_trail({
      depth,
      is_hub,
      is_last_sub,
      is_first_hub,
      parent_pipe_trail,
      parent_base_path,
      base_path,
      db
    })

    // Process hubs if they should be expanded
    const search_state = search_entry_states[instance_path]
    const should_expand_hubs = search_state ? search_state.expanded_hubs : false
    const should_expand_subs = search_state ? search_state.expanded_subs : false

    // Process hubs: if manually expanded, show ALL hubs regardless of search match
    const hub_results = []
    if (should_expand_hubs && entry.hubs) {
      for (let i = 0; i < entry.hubs.length; i++) {
        const hub_path = entry.hubs[i]
        const hub_view = await build_search_view_recursive({
          query,
          base_path: hub_path,
          parent_instance_path: instance_path,
          parent_base_path: base_path,
          depth: depth + 1,
          is_last_sub: i === entry.hubs.length - 1,
          is_hub: true,
          is_first_hub: is_hub_on_top,
          parent_pipe_trail: children_pipe_trail,
          instance_states,
          db,
          original_view_paths,
          is_expanded_child: true,
          search_tracking
        })
        hub_results.push(...hub_view)
      }
    }

    // Handle subs: if manually expanded, show ALL children; otherwise, search through them
    const sub_results = []
    if (should_expand_subs) {
      // Show ALL subs when manually expanded
      if (entry.subs) {
        for (let i = 0; i < entry.subs.length; i++) {
          const sub_path = entry.subs[i]
          const sub_view = await build_search_view_recursive({
            query,
            base_path: sub_path,
            parent_instance_path: instance_path,
            parent_base_path: base_path,
            depth: depth + 1,
            is_last_sub: i === entry.subs.length - 1,
            is_hub: false,
            is_first_hub: false,
            parent_pipe_trail: children_pipe_trail,
            instance_states,
            db,
            original_view_paths,
            is_expanded_child: true,
            search_tracking
          })
          sub_results.push(...sub_view)
        }
      }
    } else if (!is_expanded_child && is_first_occurrence_in_search) {
      // Only search through subs for the first occurrence of this base_path
      if (entry.subs) {
        for (let i = 0; i < entry.subs.length; i++) {
          const sub_path = entry.subs[i]
          const sub_view = await build_search_view_recursive({
            query,
            base_path: sub_path,
            parent_instance_path: instance_path,
            parent_base_path: base_path,
            depth: depth + 1,
            is_last_sub: i === entry.subs.length - 1,
            is_hub: false,
            is_first_hub: false,
            parent_pipe_trail: children_pipe_trail,
            instance_states,
            db,
            original_view_paths,
            is_expanded_child: false,
            search_tracking
          })
          sub_results.push(...sub_view)
        }
      }
    }

    const has_matching_descendant = sub_results.length > 0

    // If this is an expanded child, always include it regardless of search match
    // only include if it's the first occurrence OR if a dirct match
    if (!is_expanded_child && !is_direct_match && !has_matching_descendant) return []
    if (!is_expanded_child && !is_first_occurrence_in_search && !is_direct_match) return []

    const final_expand_subs = search_state ? search_state.expanded_subs : (has_matching_descendant && is_first_occurrence_in_search)
    const final_expand_hubs = search_state ? search_state.expanded_hubs : false

    instance_states[instance_path] = { expanded_subs: final_expand_subs, expanded_hubs: final_expand_hubs }
    const is_in_original_view = original_view_paths.includes(instance_path)

    // Calculate pipe_trail for this search node
    const { pipe_trail, is_hub_on_top: calculated_is_hub_on_top } = await calculate_pipe_trail({
      depth,
      is_hub,
      is_last_sub,
      is_first_hub,
      is_hub_on_top,
      parent_pipe_trail,
      parent_base_path,
      base_path,
      db
    })

    const current_node_view = {
      base_path,
      instance_path,
      depth,
      is_last_sub,
      is_hub,
      is_first_hub,
      parent_pipe_trail,
      parent_base_path,
      is_search_match: true,
      is_direct_match,
      is_in_original_view,
      entry, // Include entry data
      pipe_trail, // Pre-calculated pipe trail
      is_hub_on_top: calculated_is_hub_on_top // Pre-calculated hub position
    }

    return [...hub_results, current_node_view, ...sub_results]
  }

  function render_search_results (search_view, query) {
    view = search_view
    if (search_view.length === 0) {
      const no_results_el = document.createElement('div')
      no_results_el.className = 'no-results'
      no_results_el.textContent = `No results for "${query}"`
      return container.replaceChildren(no_results_el)
    }

    // temporary tracking map for search results to detect duplicates
    const search_tracking = {}
    search_view.forEach(node => set_search_tracking(node))

    const original_tracking = view_order_tracking
    view_order_tracking = search_tracking
    collect_all_duplicate_entries()

    const fragment = document.createDocumentFragment()
    search_view.forEach(node_data => fragment.appendChild(create_node({ ...node_data, query })))
    container.replaceChildren(fragment)

    view_order_tracking = original_tracking

    function set_search_tracking (node) {
      const { base_path, instance_path } = node
      if (!search_tracking[base_path]) search_tracking[base_path] = []
      search_tracking[base_path].push(instance_path)
    }
  }

  /******************************************************************************
  VIEW MANIPULATION & USER ACTIONS
      - These functions handle user interactions like selecting, confirming,
        toggling, and resetting the graph.
  ******************************************************************************/
  function select_node (ev, instance_path) {
    last_clicked_node = instance_path
    update_drive_state({ type: 'runtime/last_clicked_node', message: instance_path })
    send_message({ type: 'node_clicked', data: { instance_path } })

    // Handle shift+click to enable select between mode temporarily
    if (ev.shiftKey && !select_between_enabled) {
      select_between_enabled = true
      select_between_first_node = null
      update_drive_state({ type: 'mode/select_between_enabled', message: true })
      render_menubar()
    }

    const new_selected = new Set(selected_instance_paths)

    if (select_between_enabled) {
      handle_select_between(instance_path, new_selected)
    } else if (ev.ctrlKey || multi_select_enabled) {
      new_selected.has(instance_path) ? new_selected.delete(instance_path) : new_selected.add(instance_path)
      update_drive_state({ type: 'runtime/selected_instance_paths', message: [...new_selected] })
      send_message({ type: 'selection_changed', data: { selected: [...new_selected] } })
    } else {
      update_drive_state({ type: 'runtime/selected_instance_paths', message: [instance_path] })
      send_message({ type: 'selection_changed', data: { selected: [instance_path] } })
    }
  }

  function handle_select_between (instance_path, new_selected) {
    if (!select_between_first_node) {
      select_between_first_node = instance_path
    } else {
      const first_index = view.findIndex(n => n.instance_path === select_between_first_node)
      const second_index = view.findIndex(n => n.instance_path === instance_path)

      if (first_index !== -1 && second_index !== -1) {
        const start_index = Math.min(first_index, second_index)
        const end_index = Math.max(first_index, second_index)

        // Toggle selection for all nodes in the range
        for (let i = start_index; i <= end_index; i++) {
          const node_instance_path = view[i].instance_path
          new_selected.has(node_instance_path) ? new_selected.delete(node_instance_path) : new_selected.add(node_instance_path)
        }

        update_drive_state({ type: 'runtime/selected_instance_paths', message: [...new_selected] })
      }

      // Reset select between mode after second click
      select_between_enabled = false
      select_between_first_node = null
      update_drive_state({ type: 'mode/select_between_enabled', message: false })
      render_menubar()
    }
  }

  // Add the clicked entry and all its parents in the default tree
  async function expand_entry_path_in_default (target_instance_path) {
    console.log('[SEARCH DEBUG] search_expand_into_default called:', {
      target_instance_path,
      current_mode: mode,
      search_query,
      previous_mode,
      current_search_entry_states: Object.keys(search_entry_states).length,
      current_instance_states: Object.keys(instance_states).length
    })

    if (!target_instance_path) {
      console.warn('[SEARCH DEBUG] No target_instance_path provided')
      return
    }

    const parts = target_instance_path.split('|').filter(Boolean)
    if (parts.length === 0) {
      console.warn('[SEARCH DEBUG] No valid parts found in instance path:', target_instance_path)
      return
    }

    console.log('[SEARCH DEBUG] Parsed instance path parts:', parts)

    const root_state = get_or_create_state(instance_states, '|/')
    root_state.expanded_subs = true

    // Walk from root to target, expanding the path relative to already expanded entries
    for (let i = 0; i < parts.length - 1; i++) {
      const parent_base = parts[i]
      const child_base = parts[i + 1]
      const parent_instance_path = parts.slice(0, i + 1).map(p => '|' + p).join('')
      const parent_state = get_or_create_state(instance_states, parent_instance_path)
      const parent_entry = await db.get(parent_base)

      console.log('[SEARCH DEBUG] Processing parent-child relationship:', {
        parent_base,
        child_base,
        parent_instance_path,
        has_parent_entry: !!parent_entry
      })

      if (!parent_entry) continue
      if (Array.isArray(parent_entry.subs) && parent_entry.subs.includes(child_base)) {
        parent_state.expanded_subs = true
        console.log('[SEARCH DEBUG] Expanded subs for:', parent_instance_path)
      }
      if (Array.isArray(parent_entry.hubs) && parent_entry.hubs.includes(child_base)) {
        parent_state.expanded_hubs = true
        console.log('[SEARCH DEBUG] Expanded hubs for:', parent_instance_path)
      }
    }
  }

  // expand multiple selected entry in the default tree
  async function expand_selected_entries_in_default (selected_paths) {
    console.log('[SEARCH DEBUG] expand_selected_entries_in_default called:', {
      selected_paths,
      current_mode: mode,
      search_query,
      previous_mode
    })

    if (!Array.isArray(selected_paths) || selected_paths.length === 0) {
      console.warn('[SEARCH DEBUG] No valid selected paths provided')
      return
    }

    // expand foreach selected path
    for (const path of selected_paths) {
      await expand_entry_path_in_default(path)
    }

    console.log('[SEARCH DEBUG] All selected entries expanded in default mode')
  }

  // Add the clicked entry and all its parents in the default tree
  async function search_expand_into_default (target_instance_path) {
    if (!target_instance_path) {
      return
    }

    handle_search_node_click(target_instance_path)
    await expand_entry_path_in_default(target_instance_path)

    console.log('[SEARCH DEBUG] Current mode before switch:', mode)
    console.log('[SEARCH DEBUG] Target previous_mode:', previous_mode)

    // Persist selection and expansion state
    update_drive_state({ type: 'runtime/selected_instance_paths', message: [target_instance_path] })
    drive_updated_by_toggle = true
    update_drive_state({ type: 'runtime/instance_states', message: instance_states })
    search_query = ''
    update_drive_state({ type: 'mode/search_query', message: '' })

    console.log('[SEARCH DEBUG] About to switch from search mode to:', previous_mode)
    update_drive_state({ type: 'mode/current_mode', message: previous_mode })
  }

  function handle_confirm (ev, instance_path) {
    if (!ev.target) return
    const is_checked = ev.target.checked
    const new_selected = new Set(selected_instance_paths)
    const new_confirmed = new Set(confirmed_instance_paths)

    // use specific logic for mode
    if (mode === 'search') {
      handle_search_node_click(instance_path)
    } else {
      last_clicked_node = instance_path
      update_drive_state({ type: 'runtime/last_clicked_node', message: instance_path })
    }

    if (is_checked) {
      new_selected.delete(instance_path)
      new_confirmed.add(instance_path)
    } else {
      new_selected.add(instance_path)
      new_confirmed.delete(instance_path)
    }

    update_drive_state({ type: 'runtime/selected_instance_paths', message: [...new_selected] })
    update_drive_state({ type: 'runtime/confirmed_selected', message: [...new_confirmed] })
  }

  async function toggle_subs (instance_path) {
    const state = get_or_create_state(instance_states, instance_path)
    const was_expanded = state.expanded_subs
    state.expanded_subs = !state.expanded_subs

    // Update view order tracking for the toggled subs
    const base_path = instance_path.split('|').pop()
    const entry = await db.get(base_path)

    if (entry && Array.isArray(entry.subs)) {
      if (was_expanded && recursive_collapse_flag === true) {
        for (const sub_path of entry.subs) {
          await collapse_and_remove_instance(sub_path, instance_path, instance_states, db)
        }
      } else {
        for (const sub_path of entry.subs) {
          await toggle_subs_instance(sub_path, instance_path, instance_states, db)
        }
      }
    }

    last_clicked_node = instance_path
    update_drive_state({ type: 'runtime/last_clicked_node', message: instance_path })

    build_and_render_view(instance_path)
    // Set a flag to prevent the subsequent `onbatch` call from causing a render loop.
    drive_updated_by_toggle = true
    update_drive_state({ type: 'runtime/instance_states', message: instance_states })
    send_message({ type: 'subs_toggled', data: { instance_path, expanded: state.expanded_subs } })

    async function toggle_subs_instance (sub_path, instance_path, instance_states, db) {
      if (was_expanded) {
        // Collapsing so
        await remove_instances_recursively(sub_path, instance_path, instance_states, db)
      } else {
        // Expanding so
        await add_instances_recursively(sub_path, instance_path, instance_states, db)
      }
    }

    async function collapse_and_remove_instance (sub_path, instance_path, instance_states, db) {
      await collapse_subs_recursively(sub_path, instance_path, instance_states, db)
      await remove_instances_recursively(sub_path, instance_path, instance_states, db)
    }
  }

  async function toggle_hubs (instance_path) {
    const state = get_or_create_state(instance_states, instance_path)
    const was_expanded = state.expanded_hubs
    state.expanded_hubs ? hub_num-- : hub_num++
    state.expanded_hubs = !state.expanded_hubs

    // Update view order tracking for the toggled hubs
    const base_path = instance_path.split('|').pop()
    const entry = await db.get(base_path)

    if (entry && Array.isArray(entry.hubs)) {
      if (was_expanded && recursive_collapse_flag === true) {
        // collapse all hub descendants
        for (const hub_path of entry.hubs) {
          await collapse_and_remove_instance(hub_path, instance_path, instance_states, db)
        }
      } else {
        // only toggle direct hubs
        for (const hub_path of entry.hubs) {
          await toggle_hubs_instance(hub_path, instance_path, instance_states, db)
        }
      }

      async function collapse_and_remove_instance (hub_path, instance_path, instance_states, db) {
        await collapse_hubs_recursively(hub_path, instance_path, instance_states, db)
        await remove_instances_recursively(hub_path, instance_path, instance_states, db)
      }
    }

    last_clicked_node = instance_path
    drive_updated_by_scroll = true // Prevent onbatch interference with hub spacer
    update_drive_state({ type: 'runtime/last_clicked_node', message: instance_path })

    build_and_render_view(instance_path, true)
    drive_updated_by_toggle = true
    update_drive_state({ type: 'runtime/instance_states', message: instance_states })
    send_message({ type: 'hubs_toggled', data: { instance_path, expanded: state.expanded_hubs } })

    async function toggle_hubs_instance (hub_path, instance_path, instance_states, db) {
      if (was_expanded) {
        // Collapsing so
        await remove_instances_recursively(hub_path, instance_path, instance_states, db)
      } else {
        // Expanding so
        await add_instances_recursively(hub_path, instance_path, instance_states, db)
      }
    }
  }

  async function toggle_search_subs (instance_path) {
    console.log('[SEARCH DEBUG] toggle_search_subs called:', {
      instance_path,
      mode,
      search_query,
      current_state: search_entry_states[instance_path]?.expanded_subs || false,
      recursive_collapse_flag
    })

    const state = get_or_create_state(search_entry_states, instance_path)
    const old_expanded = state.expanded_subs
    state.expanded_subs = !state.expanded_subs

    if (old_expanded && recursive_collapse_flag === true) {
      const base_path = instance_path.split('|').pop()
      const entry = await db.get(base_path)
      if (entry && Array.isArray(entry.subs)) entry.subs.forEach(sub_path => collapse_search_subs_recursively(sub_path, instance_path, search_entry_states, db))
    }

    const has_matching_descendant = search_state_instances[instance_path]?.expanded_subs ? null : true
    const has_matching_parents = manipulated_inside_search[instance_path] ? search_entry_states[instance_path]?.expanded_hubs : search_state_instances[instance_path]?.expanded_hubs
    manipulated_inside_search[instance_path] = { expanded_hubs: has_matching_parents, expanded_subs: has_matching_descendant }
    console.log('[SEARCH DEBUG] Toggled subs state:', {
      instance_path,
      old_expanded,
      new_expanded: state.expanded_subs,
      recursive_state: old_expanded && recursive_collapse_flag === true
    })

    handle_search_node_click(instance_path)

    perform_search(search_query)
    drive_updated_by_search = true
    update_drive_state({ type: 'runtime/search_entry_states', message: search_entry_states })
  }

  async function toggle_search_hubs (instance_path) {
    console.log('[SEARCH DEBUG] toggle_search_hubs called:', {
      instance_path,
      mode,
      search_query,
      current_state: search_entry_states[instance_path]?.expanded_hubs || false,
      recursive_collapse_flag
    })

    const state = get_or_create_state(search_entry_states, instance_path)
    const old_expanded = state.expanded_hubs
    state.expanded_hubs = !state.expanded_hubs

    if (old_expanded && recursive_collapse_flag === true) {
      const base_path = instance_path.split('|').pop()
      const entry = await db.get(base_path)
      if (entry && Array.isArray(entry.hubs)) entry.hubs.forEach(hub_path => collapse_search_hubs_recursively(hub_path, instance_path, search_entry_states, db))
    }

    const has_matching_descendant = search_state_instances[instance_path]?.expanded_subs
    manipulated_inside_search[instance_path] = { expanded_hubs: state.expanded_hubs, expanded_subs: has_matching_descendant }
    console.log('[SEARCH DEBUG] Toggled hubs state:', {
      instance_path,
      old_expanded,
      new_expanded: state.expanded_hubs,
      recursive_state: old_expanded && recursive_collapse_flag === true
    })

    handle_search_node_click(instance_path)

    console.log('[SEARCH DEBUG] About to perform_search after toggle_search_hubs')
    perform_search(search_query)
    drive_updated_by_search = true
    update_drive_state({ type: 'runtime/search_entry_states', message: search_entry_states })
    console.log('[SEARCH DEBUG] toggle_search_hubs completed')
  }

  function handle_search_node_click (instance_path) {
    console.log('[SEARCH DEBUG] handle_search_node_click called:', {
      instance_path,
      current_mode: mode,
      search_query,
      previous_last_clicked: last_clicked_node
    })

    if (mode !== 'search') {
      console.warn('[SEARCH DEBUG] handle_search_node_click called but not in search mode!', {
        current_mode: mode,
        instance_path
      })
      return
    }

    // we need to handle last_clicked_node differently
    const old_last_clicked = last_clicked_node
    last_clicked_node = instance_path

    console.log('[SEARCH DEBUG] Updating last_clicked_node:', {
      old_value: old_last_clicked,
      new_value: last_clicked_node,
      mode,
      search_query
    })

    update_drive_state({ type: 'runtime/last_clicked_node', message: instance_path })

    // Update visual styling for search mode nodes
    update_search_last_clicked_styling(instance_path)
  }

  function update_search_last_clicked_styling (target_instance_path) {
    console.log('[SEARCH DEBUG] update_search_last_clicked_styling called:', {
      target_instance_path,
      mode,
      search_query
    })

    // Remove `last-clicked` class from all search result nodes
    const search_nodes = container.querySelectorAll('.node.search-result')
    console.log('[SEARCH DEBUG] Found search result nodes:', search_nodes.length)
    search_nodes.forEach(node => remove_last_clicked_styling(node))

    // Add last-clicked class to the target node if it exists in search results
    const target_node = container.querySelector(`[data-instance_path="${target_instance_path}"].search-result`)
    if (target_node) {
      mode === 'search' ? target_node.classList.add('search-last-clicked') : target_node.classList.add('last-clicked')
      console.log('[SEARCH DEBUG] Added last-clicked to target node:', target_instance_path)
    } else {
      console.warn('[SEARCH DEBUG] Target node not found in search results:', {
        target_instance_path,
        available_search_nodes: Array.from(search_nodes).map(n => n.dataset.instance_path)
      })
    }

    function remove_last_clicked_styling (node) {
      const was_last_clicked = node.classList.contains('last-clicked')
      mode === 'search' ? node.classList.remove('search-last-clicked') : node.classList.remove('last-clicked')
      if (was_last_clicked) {
        console.log('[SEARCH DEBUG] Removed last-clicked from:', node.dataset.instance_path)
      }
    }
  }

  function handle_search_name_click (ev, instance_path) {
    console.log('[SEARCH DEBUG] handle_search_name_click called:', {
      instance_path,
      mode,
      search_query,
      ctrlKey: ev.ctrlKey,
      metaKey: ev.metaKey,
      shiftKey: ev.shiftKey,
      multi_select_enabled,
      current_selected: selected_instance_paths.length
    })

    if (mode !== 'search') {
      console.error('[SEARCH DEBUG] handle_search_name_click called but not in search mode!', {
        current_mode: mode,
        instance_path
      })
      return
    }

    handle_search_node_click(instance_path)

    if (ev.ctrlKey || ev.metaKey || multi_select_enabled) {
      search_select_node(ev, instance_path)
    } else if (ev.shiftKey) {
      search_select_node(ev, instance_path)
    } else if (select_between_enabled) {
      // Handle select-between mode when button is enabled
      search_select_node(ev, instance_path)
    } else {
      // Regular click
      search_expand_into_default(instance_path)
    }
  }

  function search_select_node (ev, instance_path) {
    console.log('[SEARCH DEBUG] search_select_node called:', {
      instance_path,
      mode,
      search_query,
      shiftKey: ev.shiftKey,
      ctrlKey: ev.ctrlKey,
      metaKey: ev.metaKey,
      multi_select_enabled,
      select_between_enabled,
      select_between_first_node,
      current_selected: selected_instance_paths
    })

    const new_selected = new Set(selected_instance_paths)

    if (select_between_enabled) {
      if (!select_between_first_node) {
        select_between_first_node = instance_path
        console.log('[SEARCH DEBUG] Set first node for select between:', instance_path)
      } else {
        console.log('[SEARCH DEBUG] Completing select between range:', {
          first: select_between_first_node,
          second: instance_path
        })
        const first_index = view.findIndex(n => n.instance_path === select_between_first_node)
        const second_index = view.findIndex(n => n.instance_path === instance_path)

        if (first_index !== -1 && second_index !== -1) {
          const start_index = Math.min(first_index, second_index)
          const end_index = Math.max(first_index, second_index)

          // Toggle selection for all nodes in between
          for (let i = start_index; i <= end_index; i++) {
            const node_instance_path = view[i].instance_path
            if (new_selected.has(node_instance_path)) {
              new_selected.delete(node_instance_path)
            } else {
              new_selected.add(node_instance_path)
            }
          }
        }

        // Reset select between mode after completing the selection
        select_between_enabled = false
        select_between_first_node = null
        update_drive_state({ type: 'mode/select_between_enabled', message: false })
        render_menubar()
        console.log('[SEARCH DEBUG] Reset select between mode')
      }
    } else if (ev.shiftKey) {
      // Enable select between mode on shift click
      select_between_enabled = true
      select_between_first_node = instance_path
      update_drive_state({ type: 'mode/select_between_enabled', message: true })
      render_menubar()
      console.log('[SEARCH DEBUG] Enabled select between mode with first node:', instance_path)
      return
    } else if (multi_select_enabled || ev.ctrlKey || ev.metaKey) {
      if (new_selected.has(instance_path)) {
        console.log('[SEARCH DEBUG] Deselecting node:', instance_path)
        new_selected.delete(instance_path)
      } else {
        console.log('[SEARCH DEBUG] Selecting node:', instance_path)
        new_selected.add(instance_path)
      }
    } else {
      // Single selection mode
      new_selected.clear()
      new_selected.add(instance_path)
      console.log('[SEARCH DEBUG] Single selecting node:', instance_path)
    }

    const new_selection_array = [...new_selected]
    update_drive_state({ type: 'runtime/selected_instance_paths', message: new_selection_array })
    console.log('[SEARCH DEBUG] search_select_node completed, new selection:', new_selection_array)
  }

  function reset () {
    // reset all of the manual expansions made
    instance_states = {}
    view_order_tracking = {} // Clear view order tracking on reset
    drive_updated_by_tracking = true
    update_drive_state({ type: 'runtime/view_order_tracking', message: view_order_tracking })
    if (mode === 'search') {
      search_entry_states = {}
      drive_updated_by_toggle = true
      update_drive_state({ type: 'runtime/search_entry_states', message: search_entry_states })
      perform_search(search_query)
      return
    }
    const root_instance_path = '|/'
    const new_instance_states = {
      [root_instance_path]: { expanded_subs: true, expanded_hubs: false }
    }
    update_drive_state({ type: 'runtime/vertical_scroll_value', message: 0 })
    update_drive_state({ type: 'runtime/horizontal_scroll_value', message: 0 })
    update_drive_state({ type: 'runtime/selected_instance_paths', message: [] })
    update_drive_state({ type: 'runtime/confirmed_selected', message: [] })
    update_drive_state({ type: 'runtime/instance_states', message: new_instance_states })
  }

  /******************************************************************************
  VIRTUAL SCROLLING
    - These functions implement virtual scrolling to handle large graphs
      efficiently using an IntersectionObserver.
  ******************************************************************************/
  function onscroll () {
    if (scroll_update_pending) return
    scroll_update_pending = true
    requestAnimationFrame(scroll_frames)
    function scroll_frames () {
      const scroll_delta = vertical_scroll_value - container.scrollTop
      // Handle removal of the scroll spacer.
      if (spacer_element && scroll_delta > 0 && container.scrollTop === 0) {
        spacer_element.remove()
        spacer_element = null
        spacer_initial_height = 0
        hub_num = 0
      }

      vertical_scroll_value = update_scroll_state({ current_value: vertical_scroll_value, new_value: container.scrollTop, name: 'vertical_scroll_value' })
      horizontal_scroll_value = update_scroll_state({ current_value: horizontal_scroll_value, new_value: container.scrollLeft, name: 'horizontal_scroll_value' })
      scroll_update_pending = false
    }
  }

  async function fill_viewport_downwards () {
    if (is_rendering || end_index >= view.length) return
    is_rendering = true
    const container_rect = container.getBoundingClientRect()
    let sentinel_rect = bottom_sentinel.getBoundingClientRect()
    while (end_index < view.length && sentinel_rect.top < container_rect.bottom + 500) {
      render_next_chunk()
      await new Promise(resolve => requestAnimationFrame(resolve))
      sentinel_rect = bottom_sentinel.getBoundingClientRect()
    }
    is_rendering = false
  }

  async function fill_viewport_upwards () {
    if (is_rendering || start_index <= 0) return
    is_rendering = true
    const container_rect = container.getBoundingClientRect()
    let sentinel_rect = top_sentinel.getBoundingClientRect()
    while (start_index > 0 && sentinel_rect.bottom > container_rect.top - 500) {
      render_prev_chunk()
      await new Promise(resolve => requestAnimationFrame(resolve))
      sentinel_rect = top_sentinel.getBoundingClientRect()
    }
    is_rendering = false
  }

  function handle_sentinel_intersection (entries) {
    entries.forEach(entry => fill_downwards_or_upwards(entry))
  }

  function fill_downwards_or_upwards (entry) {
    if (entry.isIntersecting) {
      if (entry.target === top_sentinel) fill_viewport_upwards()
      else if (entry.target === bottom_sentinel) fill_viewport_downwards()
    }
  }

  function render_next_chunk () {
    if (end_index >= view.length) return
    const fragment = document.createDocumentFragment()
    const next_end = Math.min(view.length, end_index + chunk_size)
    for (let i = end_index; i < next_end; i++) { if (view[i]) fragment.appendChild(create_node(view[i])) }
    container.insertBefore(fragment, bottom_sentinel)
    end_index = next_end
    bottom_sentinel.style.height = `${(view.length - end_index) * node_height}px`
    cleanup_dom(false)
  }

  function render_prev_chunk () {
    if (start_index <= 0) return
    const fragment = document.createDocumentFragment()
    const prev_start = Math.max(0, start_index - chunk_size)
    for (let i = prev_start; i < start_index; i++) {
      if (view[i]) fragment.appendChild(create_node(view[i]))
    }
    container.insertBefore(fragment, top_sentinel.nextSibling)
    start_index = prev_start
    top_sentinel.style.height = `${start_index * node_height}px`
    cleanup_dom(true)
  }

  // Removes nodes from the DOM that are far outside the viewport.
  function cleanup_dom (is_scrolling_up) {
    const rendered_count = end_index - start_index
    if (rendered_count <= max_rendered_nodes) return

    const to_remove_count = rendered_count - max_rendered_nodes
    if (is_scrolling_up) {
      // If scrolling up, remove nodes from the bottom.
      remove_dom_nodes({ count: to_remove_count, start_el: bottom_sentinel, next_prop: 'previousElementSibling', boundary_el: top_sentinel })
      end_index -= to_remove_count
      bottom_sentinel.style.height = `${(view.length - end_index) * node_height}px`
    } else {
      // If scrolling down, remove nodes from the top.
      remove_dom_nodes({ count: to_remove_count, start_el: top_sentinel, next_prop: 'nextElementSibling', boundary_el: bottom_sentinel })
      start_index += to_remove_count
      top_sentinel.style.height = `${start_index * node_height}px`
    }
  }

  /******************************************************************************
  ENTRY DUPLICATION PREVENTION
  ******************************************************************************/

  function collect_all_duplicate_entries () {
    duplicate_entries_map = {}
    // Use view_order_tracking for duplicate detection
    for (const [base_path, instance_paths] of Object.entries(view_order_tracking)) {
      if (instance_paths.length > 1) {
        duplicate_entries_map[base_path] = {
          instances: instance_paths,
          first_instance: instance_paths[0] // First occurrence in view order
        }
      }
    }
  }

  async function initialize_tracking_from_current_state () {
    const root_path = '/'
    const root_instance_path = '|/'
    if (await db.has(root_path)) {
      add_instance_to_view_tracking(root_path, root_instance_path)
      // Add initially expanded subs if any
      const root_entry = await db.get(root_path)
      if (root_entry && Array.isArray(root_entry.subs)) {
        for (const sub_path of root_entry.subs) {
          await add_instances_recursively(sub_path, root_instance_path, instance_states, db)
        }
      }
    }
  }

  function add_instance_to_view_tracking (base_path, instance_path) {
    if (!view_order_tracking[base_path]) view_order_tracking[base_path] = []
    if (!view_order_tracking[base_path].includes(instance_path)) {
      view_order_tracking[base_path].push(instance_path)

      // Only save to drive if not currently loading from drive
      if (!is_loading_from_drive) {
        drive_updated_by_tracking = true
        update_drive_state({ type: 'runtime/view_order_tracking', message: view_order_tracking })
      }
    }
  }

  function remove_instance_from_view_tracking (base_path, instance_path) {
    if (view_order_tracking[base_path]) {
      const index = view_order_tracking[base_path].indexOf(instance_path)
      if (index !== -1) {
        view_order_tracking[base_path].splice(index, 1)
        // Clean up empty arrays
        if (view_order_tracking[base_path].length === 0) {
          delete view_order_tracking[base_path]
        }

        // Only save to drive if not currently loading from drive
        if (!is_loading_from_drive) {
          drive_updated_by_tracking = true
          update_drive_state({ type: 'runtime/view_order_tracking', message: view_order_tracking })
        }
      }
    }
  }

  // Recursively add instances to tracking when expanding
  async function add_instances_recursively (base_path, parent_instance_path, instance_states, db) {
    const instance_path = `${parent_instance_path}|${base_path}`
    const entry = await db.get(base_path)
    if (!entry) return

    const state = get_or_create_state(instance_states, instance_path)

    if (state.expanded_hubs && Array.isArray(entry.hubs)) {
      for (const hub_path of entry.hubs) {
        await add_instances_recursively(hub_path, instance_path, instance_states, db)
      }
    }

    if (state.expanded_subs && Array.isArray(entry.subs)) {
      for (const sub_path of entry.subs) {
        await add_instances_recursively(sub_path, instance_path, instance_states, db)
      }
    }

    // Add the instance itself
    add_instance_to_view_tracking(base_path, instance_path)
  }

  // Recursively remove instances from tracking when collapsing
  async function remove_instances_recursively (base_path, parent_instance_path, instance_states, db) {
    const instance_path = `${parent_instance_path}|${base_path}`
    const entry = await db.get(base_path)
    if (!entry) return

    const state = get_or_create_state(instance_states, instance_path)

    if (state.expanded_hubs && Array.isArray(entry.hubs)) {
      for (const hub_path of entry.hubs) {
        await remove_instances_recursively(hub_path, instance_path, instance_states, db)
      }
    }
    if (state.expanded_subs && Array.isArray(entry.subs)) {
      for (const sub_path of entry.subs) {
        await remove_instances_recursively(sub_path, instance_path, instance_states, db)
      }
    }

    // Remove the instance itself
    remove_instance_from_view_tracking(base_path, instance_path)
  }

  // Recursively hubs all subs in default mode
  async function collapse_subs_recursively (base_path, parent_instance_path, instance_states, db) {
    const instance_path = `${parent_instance_path}|${base_path}`
    const entry = await db.get(base_path)
    if (!entry) return

    const state = get_or_create_state(instance_states, instance_path)

    if (state.expanded_subs && Array.isArray(entry.subs)) {
      state.expanded_subs = false
      for (const sub_path of entry.subs) {
        await collapse_and_remove_instance(sub_path, instance_path, instance_states, db)
      }
    }

    if (state.expanded_hubs && Array.isArray(entry.hubs)) {
      state.expanded_hubs = false
      hub_num = Math.max(0, hub_num - 1) // Decrement hub counter
      for (const hub_path of entry.hubs) {
        await collapse_and_remove_instance(hub_path, instance_path, instance_states, db)
      }
    }
    async function collapse_and_remove_instance (base_path, instance_path, instance_states, db) {
      await collapse_subs_recursively(base_path, instance_path, instance_states, db)
      await remove_instances_recursively(base_path, instance_path, instance_states, db)
    }
  }

  // Recursively hubs all hubs in default mode
  async function collapse_hubs_recursively (base_path, parent_instance_path, instance_states, db) {
    const instance_path = `${parent_instance_path}|${base_path}`
    const entry = await db.get(base_path)
    if (!entry) return

    const state = get_or_create_state(instance_states, instance_path)

    if (state.expanded_hubs && Array.isArray(entry.hubs)) {
      state.expanded_hubs = false
      hub_num = Math.max(0, hub_num - 1)
      for (const hub_path of entry.hubs) {
        await collapse_and_remove_instance(hub_path, instance_path, instance_states, db)
      }
    }

    if (state.expanded_subs && Array.isArray(entry.subs)) {
      state.expanded_subs = false
      for (const sub_path of entry.subs) {
        await collapse_and_remove_instance(sub_path, instance_path, instance_states, db)
      }
    }
    async function collapse_and_remove_instance (base_path, instance_path, instance_states, db) {
      await collapse_all_recursively(base_path, instance_path, instance_states, db)
      await remove_instances_recursively(base_path, instance_path, instance_states, db)
    }
  }

  // Recursively collapse in default mode
  async function collapse_all_recursively (base_path, parent_instance_path, instance_states, db) {
    const instance_path = `${parent_instance_path}|${base_path}`
    const entry = await db.get(base_path)
    if (!entry) return

    const state = get_or_create_state(instance_states, instance_path)

    if (state.expanded_subs && Array.isArray(entry.subs)) {
      state.expanded_subs = false
      for (const sub_path of entry.subs) {
        await collapse_and_remove_instance_recursively(sub_path, instance_path, instance_states, db)
      }
    }

    if (state.expanded_hubs && Array.isArray(entry.hubs)) {
      state.expanded_hubs = false
      hub_num = Math.max(0, hub_num - 1)
      for (const hub_path of entry.hubs) {
        await collapse_and_remove_instance_recursively(hub_path, instance_path, instance_states, db)
      }
    }

    async function collapse_and_remove_instance_recursively (base_path, instance_path, instance_states, db) {
      await collapse_all_recursively(base_path, instance_path, instance_states, db)
      await remove_instances_recursively(base_path, instance_path, instance_states, db)
    }
  }

  // Recursively subs all hubs in search mode
  async function collapse_search_subs_recursively (base_path, parent_instance_path, search_entry_states, db) {
    const instance_path = `${parent_instance_path}|${base_path}`
    const entry = await db.get(base_path)
    if (!entry) return

    const state = get_or_create_state(search_entry_states, instance_path)

    if (state.expanded_subs && Array.isArray(entry.subs)) {
      state.expanded_subs = false
      for (const sub_path of entry.subs) {
        await collapse_search_all_recursively(sub_path, instance_path, search_entry_states, db)
      }
    }

    if (state.expanded_hubs && Array.isArray(entry.hubs)) {
      state.expanded_hubs = false
      for (const hub_path of entry.hubs) {
        await collapse_search_all_recursively(hub_path, instance_path, search_entry_states, db)
      }
    }
  }

  // Recursively hubs all hubs in search mode
  async function collapse_search_hubs_recursively (base_path, parent_instance_path, search_entry_states, db) {
    const instance_path = `${parent_instance_path}|${base_path}`
    const entry = await db.get(base_path)
    if (!entry) return

    const state = get_or_create_state(search_entry_states, instance_path)

    if (state.expanded_hubs && Array.isArray(entry.hubs)) {
      state.expanded_hubs = false
      for (const hub_path of entry.hubs) {
        await collapse_search_all_recursively(hub_path, instance_path, search_entry_states, db)
      }
    }

    if (state.expanded_subs && Array.isArray(entry.subs)) {
      state.expanded_subs = false
      for (const sub_path of entry.subs) {
        await collapse_search_all_recursively(sub_path, instance_path, search_entry_states, db)
      }
    }
  }

  // Recursively collapse in search mode
  async function collapse_search_all_recursively (base_path, parent_instance_path, search_entry_states, db) {
    const instance_path = `${parent_instance_path}|${base_path}`
    const entry = await db.get(base_path)
    if (!entry) return

    const state = get_or_create_state(search_entry_states, instance_path)

    if (state.expanded_subs && Array.isArray(entry.subs)) {
      state.expanded_subs = false
      for (const sub_path of entry.subs) {
        await collapse_search_all_recursively(sub_path, instance_path, search_entry_states, db)
      }
    }

    if (state.expanded_hubs && Array.isArray(entry.hubs)) {
      state.expanded_hubs = false
      for (const hub_path of entry.hubs) {
        await collapse_search_all_recursively(hub_path, instance_path, search_entry_states, db)
      }
    }
  }

  function get_next_duplicate_instance (base_path, current_instance_path) {
    const duplicates = duplicate_entries_map[base_path]
    if (!duplicates || duplicates.instances.length <= 1) return null

    const current_index = duplicates.instances.indexOf(current_instance_path)
    if (current_index === -1) return duplicates.instances[0]

    const next_index = (current_index + 1) % duplicates.instances.length
    return duplicates.instances[next_index]
  }

  function has_duplicates (base_path) {
    return duplicate_entries_map[base_path] && duplicate_entries_map[base_path].instances.length > 1
  }

  function is_first_duplicate (base_path, instance_path) {
    const duplicates = duplicate_entries_map[base_path]
    return duplicates && duplicates.first_instance === instance_path
  }

  function cycle_to_next_duplicate (base_path, current_instance_path) {
    const next_instance_path = get_next_duplicate_instance(base_path, current_instance_path)
    if (next_instance_path) {
      remove_jump_button_from_entry(current_instance_path)

      // First, handle the scroll and DOM updates without drive state changes
      scroll_to_and_highlight_instance(next_instance_path, current_instance_path)

      // Manually update DOM styling
      update_last_clicked_styling(next_instance_path)
      last_clicked_node = next_instance_path
      drive_updated_by_scroll = true // Prevent onbatch from interfering with scroll
      drive_updated_by_match = true
      update_drive_state({ type: 'runtime/last_clicked_node', message: next_instance_path })

      // Add jump button to the target entry (with a small delay to ensure DOM is ready)
      setTimeout(jump_out, 10)
      function jump_out () {
        const target_element = shadow.querySelector(`[data-instance_path="${CSS.escape(next_instance_path)}"]`)
        if (target_element) {
          add_jump_button_to_matching_entry(target_element, base_path, next_instance_path)
        }
      }
    }
  }

  function update_last_clicked_styling (new_instance_path) {
    // Remove last-clicked class from all elements
    const all_nodes = mode === 'search' ? shadow.querySelectorAll('.node.search-last-clicked') : shadow.querySelectorAll('.node.last-clicked')
    console.log('Removing last-clicked class from all nodes', all_nodes)
    all_nodes.forEach(node => (mode === 'search' ? node.classList.remove('search-last-clicked') : node.classList.remove('last-clicked')))
    // Add last-clicked class to the new element
    if (new_instance_path) {
      const new_element = shadow.querySelector(`[data-instance_path="${CSS.escape(new_instance_path)}"]`)
      if (new_element) {
        mode === 'search' ? new_element.classList.add('search-last-clicked') : new_element.classList.add('last-clicked')
      }
    }
  }

  function remove_jump_button_from_entry (instance_path) {
    const current_element = shadow.querySelector(`[data-instance_path="${CSS.escape(instance_path)}"]`)
    if (current_element) {
      // restore the wand icon
      const node_data = view.find(n => n.instance_path === instance_path)
      if (node_data && node_data.base_path === '/' && instance_path === '|/') {
        const wand_el = current_element.querySelector('.wand.navigate-to-hub')
        if (wand_el && root_wand_state) {
          wand_el.textContent = root_wand_state.content
          wand_el.className = root_wand_state.className
          wand_el.onclick = root_wand_state.onclick

          root_wand_state = null
        }
        return
      }

      // Regular behavior for non-root nodes
      const button_container = current_element.querySelector('.indent-btn-container')
      if (button_container) {
        button_container.remove()
        // Restore left-indent class
        if (node_data && node_data.depth > 0) {
          current_element.classList.add('left-indent')
        }
      }
    }
  }

  function add_jump_button_to_matching_entry (el, base_path, instance_path) {
    // Check if jump button already exists
    if (el.querySelector('.navigate-to-hub')) return

    // replace the wand icon temporarily
    if (base_path === '/' && instance_path === '|/') {
      const wand_el = el.querySelector('.wand')
      if (wand_el) {
        // Store original wand state in JavaScript variable
        root_wand_state = {
          content: wand_el.textContent,
          className: wand_el.className,
          onclick: wand_el.onclick
        }

        // Replace with jump button
        wand_el.textContent = '^'
        wand_el.className = 'wand navigate-to-hub clickable'
        wand_el.onclick = (ev) => handle_jump_button_click(ev, instance_path)
      }
      return

      function handle_jump_button_click (ev, instance_path) {
        ev.stopPropagation()
        last_clicked_node = instance_path
        drive_updated_by_match = true
        update_drive_state({ type: 'runtime/last_clicked_node', message: instance_path })

        update_last_clicked_styling(instance_path)

        cycle_to_next_duplicate(base_path, instance_path)
      }
    }

    const indent_button_div = document.createElement('div')
    indent_button_div.className = 'indent-btn-container'

    const navigate_button = document.createElement('span')
    navigate_button.className = 'navigate-to-hub clickable'
    navigate_button.textContent = '^'
    navigate_button.onclick = (ev) => handle_navigate_button_click(ev, instance_path)

    indent_button_div.appendChild(navigate_button)

    // Remove left padding
    el.classList.remove('left-indent')
    el.insertBefore(indent_button_div, el.firstChild)

    function handle_navigate_button_click (ev, instance_path) {
      ev.stopPropagation() // Prevent triggering the whole entry click again
      // Manually update last clicked node for jump button
      last_clicked_node = instance_path
      drive_updated_by_match = true
      update_drive_state({ type: 'runtime/last_clicked_node', message: instance_path })

      // Manually update DOM classes for last-clicked styling
      update_last_clicked_styling(instance_path)

      cycle_to_next_duplicate(base_path, instance_path)
    }
  }

  function scroll_to_and_highlight_instance (target_instance_path, source_instance_path = null) {
    const target_index = view.findIndex(n => n.instance_path === target_instance_path)
    if (target_index === -1) return

    // Calculate scroll position
    let target_scroll_top = target_index * node_height

    if (source_instance_path) {
      const source_index = view.findIndex(n => n.instance_path === source_instance_path)
      if (source_index !== -1) {
        const source_scroll_top = source_index * node_height
        const current_scroll_top = container.scrollTop
        const source_visible_offset = source_scroll_top - current_scroll_top
        target_scroll_top = target_scroll_top - source_visible_offset
      }
    }

    container.scrollTop = target_scroll_top
  }

  /******************************************************************************
  HELPER FUNCTIONS
  ******************************************************************************/
  function get_highlighted_name (name, query) {
  // Creates a new regular expression.
  // `escape_regex(query)` sanitizes the query string to treat special regex characters literally.
  // `(...)` creates a capturing group for the escaped query.
  // 'gi' flags: 'g' for global (all occurrences), 'i' for case-insensitive.
    const regex = new RegExp(`(${escape_regex(query)})`, 'gi')
    // Replaces all matches of the regex in 'name' with the matched text wrapped in search-match class.
    // '$1' refers to the content of the first capturing group (the matched query).
    return name.replace(regex, '<span class="search-match">$1</span>')
  }

  function escape_regex (string) {
  // Escapes special regular expression characters in a string.
  // It replaces characters like -, /, \, ^, $, *, +, ?, ., (, ), |, [, ], {, }
  // with their escaped versions (e.g., '.' becomes '\.').
  // This prevents them from being interpreted as regex metacharacters.
    return string.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') // Corrected: should be \\$& to escape the found char
  }

  function check_and_reset_feedback_flags () {
    if (drive_updated_by_scroll && !ignore_drive_updated_by_scroll) {
      drive_updated_by_scroll = false
      return true
    } else ignore_drive_updated_by_scroll = false
    if (drive_updated_by_toggle) {
      drive_updated_by_toggle = false
      return true
    }
    if (drive_updated_by_search) {
      drive_updated_by_search = false
      return true
    }
    if (drive_updated_by_match) {
      drive_updated_by_match = false
      return true
    }
    if (drive_updated_by_tracking) {
      drive_updated_by_tracking = false
      return true
    }
    if (drive_updated_by_last_clicked) {
      drive_updated_by_last_clicked = false
      return true
    }
    if (drive_updated_by_undo) {
      drive_updated_by_undo = false
      return true
    }
    console.log('[SEARCH DEBUG] No feedback flags set, allowing onbatch')
    return false
  }

  function parse_json_data (data, path) {
    if (data === null) return null
    try {
      return typeof data === 'string' ? JSON.parse(data) : data
    } catch (e) {
      console.error(`Failed to parse JSON for ${path}:`, e)
      return null
    }
  }

  function process_path_array_update ({ current_paths, value, render_set, name }) {
    const old_paths = [...current_paths]
    const new_paths = Array.isArray(value)
      ? value
      : (console.warn(`${name} is not an array, defaulting to empty.`, value), [])
    ;[...new Set([...old_paths, ...new_paths])].forEach(p => render_set.add(p))
    return new_paths
  }

  function calculate_new_scroll_top ({ old_scroll_top, old_view, focal_path }) {
    // Calculate the new scroll position to maintain the user's viewport.
    if (focal_path) {
      // If an action was focused on a specific node (like a toggle), try to keep it in the same position.
      const old_idx = old_view.findIndex(n => n.instance_path === focal_path)
      const new_idx = view.findIndex(n => n.instance_path === focal_path)
      if (old_idx !== -1 && new_idx !== -1) {
        return old_scroll_top + (new_idx - old_idx) * node_height
      }
    } else if (old_view.length > 0) {
      // Otherwise, try to keep the topmost visible node in the same position.
      const old_top_idx = Math.floor(old_scroll_top / node_height)
      const old_top_node = old_view[old_top_idx]
      if (old_top_node) {
        const new_top_idx = view.findIndex(n => n.instance_path === old_top_node.instance_path)
        if (new_top_idx !== -1) {
          return new_top_idx * node_height + (old_scroll_top % node_height)
        }
      }
    }
    return old_scroll_top
  }

  function handle_spacer_element ({ hub_toggle, existing_height, new_scroll_top, sync_fn }) {
    if (hub_toggle || hub_num > 0) {
      spacer_element = document.createElement('div')
      spacer_element.className = 'spacer'
      container.appendChild(spacer_element)

      if (hub_toggle) {
        requestAnimationFrame(spacer_frames)
      } else {
        spacer_element.style.height = `${existing_height}px`
        requestAnimationFrame(sync_fn)
      }
    } else {
      spacer_element = null
      spacer_initial_height = 0
      requestAnimationFrame(sync_fn)
    }
    function spacer_frames () {
      const container_height = container.clientHeight
      const content_height = view.length * node_height
      const max_scroll_top = content_height - container_height

      if (new_scroll_top > max_scroll_top) {
        spacer_initial_height = new_scroll_top - max_scroll_top
        spacer_element.style.height = `${spacer_initial_height}px`
      }
      sync_fn()
    }
  }

  function create_root_node ({ state, has_subs, instance_path }) {
    // Handle the special case for the root node since its a bit different.
    const el = document.createElement('div')
    el.className = 'node type-root'
    el.dataset.instance_path = instance_path
    const prefix_class = has_subs || (mode === 'search' && search_query) ? 'prefix clickable' : 'prefix'
    const prefix_name = state.expanded_subs ? 'tee-down' : 'line-h'
    el.innerHTML = `<div class="wand clickable">🪄</div><span class="${prefix_class} ${prefix_name}"></span><span class="name ${(mode === 'search' && search_query) ? '' : 'clickable'}">/🌐</span>`

    el.querySelector('.wand').onclick = reset
    if (has_subs) {
      const prefix_el = el.querySelector('.prefix')
      if (prefix_el) {
        prefix_el.onclick = (mode === 'search' && search_query) ? null : () => toggle_subs(instance_path)
      }
    }
    el.querySelector('.name').onclick = ev => (mode === 'search' && search_query) ? null : select_node(ev, instance_path)
    return el
  }

  function create_confirm_checkbox (instance_path) {
    const checkbox_div = document.createElement('div')
    checkbox_div.className = 'confirm-wrapper'
    const is_confirmed = confirmed_instance_paths.includes(instance_path)
    checkbox_div.innerHTML = `<input type="checkbox" ${is_confirmed ? 'checked' : ''}>`
    const checkbox_input = checkbox_div.querySelector('input')
    if (checkbox_input) checkbox_input.onchange = ev => handle_confirm(ev, instance_path)
    return checkbox_div
  }

  function update_scroll_state ({ current_value, new_value, name }) {
    if (current_value !== new_value) {
      drive_updated_by_scroll = true // Set flag to prevent render loop.
      update_drive_state({ type: `runtime/${name}`, message: new_value })
      return new_value
    }
    return current_value
  }

  function remove_dom_nodes ({ count, start_el, next_prop, boundary_el }) {
    for (let i = 0; i < count; i++) {
      const temp = start_el[next_prop]
      if (temp && temp !== boundary_el) temp.remove()
      else break
    }
  }

  /******************************************************************************
  KEYBOARD NAVIGATION
    - Handles keyboard-based navigation for the graph explorer
    - Navigate up/down around last_clicked node
  ******************************************************************************/
  function handle_keyboard_navigation (event) {
    // Don't handle keyboard events if focus is on input elements
    if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') {
      return
    }
    const on_bind = {
      navigate_up_current_node,
      navigate_down_current_node,
      toggle_subs_for_current_node,
      toggle_hubs_for_current_node,
      multiselect_current_node,
      select_between_current_node,
      toggle_search_mode,
      jump_to_next_duplicate

    }
    let key_combination = ''
    if (event.ctrlKey) key_combination += 'Control+'
    if (event.altKey) key_combination += 'Alt+'
    if (event.shiftKey) key_combination += 'Shift+'
    key_combination += event.key

    const action = keybinds[key_combination] || keybinds[event.key]
    if (!action) return

    // Prevent default behavior for handled keys
    event.preventDefault()
    const base_path = last_clicked_node.split('|').pop()
    const current_instance_path = last_clicked_node
    // Execute the appropriate action
    on_bind[action]({ base_path, current_instance_path })
  }
  function navigate_up_current_node () {
    navigate_to_adjacent_node(-1)
  }
  function navigate_down_current_node () {
    navigate_to_adjacent_node(1)
  }
  function navigate_to_adjacent_node (direction) {
    if (view.length === 0) return
    if (!last_clicked_node) last_clicked_node = view[0].instance_path
    const current_index = view.findIndex(node => node.instance_path === last_clicked_node)
    if (current_index === -1) return

    const new_index = current_index + direction
    if (new_index < 0 || new_index >= view.length) return

    const new_node = view[new_index]
    last_clicked_node = new_node.instance_path
    drive_updated_by_last_clicked = true
    update_drive_state({ type: 'runtime/last_clicked_node', message: last_clicked_node })

    // Update visual styling
    if (mode === 'search' && search_query) {
      update_search_last_clicked_styling(last_clicked_node)
    } else {
      update_last_clicked_styling(last_clicked_node)
    }
    const base_path = last_clicked_node.split('|').pop()
    const has_duplicate_entries = has_duplicates(base_path)
    const is_first_occurrence = is_first_duplicate(base_path, last_clicked_node)
    if (has_duplicate_entries && !is_first_occurrence) {
      const el = shadow.querySelector(`[data-instance_path="${CSS.escape(last_clicked_node)}"]`)
      add_jump_button_to_matching_entry(el, base_path, last_clicked_node)
    }
    scroll_to_node(new_node.instance_path)
  }

  async function toggle_subs_for_current_node () {
    if (!last_clicked_node) return

    const base_path = last_clicked_node.split('|').pop()
    const entry = await db.get(base_path)
    const has_subs = Array.isArray(entry?.subs) && entry.subs.length > 0
    if (!has_subs) return

    if (hubs_flag === 'default') {
      const has_duplicate_entries = has_duplicates(base_path)
      const is_first_occurrence = is_first_duplicate(base_path, last_clicked_node)
      if (has_duplicate_entries && !is_first_occurrence) return
    }

    if (mode === 'search' && search_query) {
      await toggle_search_subs(last_clicked_node)
    } else {
      await toggle_subs(last_clicked_node)
    }
  }

  async function toggle_hubs_for_current_node () {
    if (!last_clicked_node) return

    const base_path = last_clicked_node.split('|').pop()
    const entry = await db.get(base_path)
    const has_hubs = hubs_flag === 'false' ? false : Array.isArray(entry?.hubs) && entry.hubs.length > 0
    if (!has_hubs || base_path === '/') return

    if (hubs_flag === 'default') {
      const has_duplicate_entries = has_duplicates(base_path)
      const is_first_occurrence = is_first_duplicate(base_path, last_clicked_node)

      if (has_duplicate_entries && !is_first_occurrence) return
    }

    if (mode === 'search' && search_query) {
      await toggle_search_hubs(last_clicked_node)
    } else {
      await toggle_hubs(last_clicked_node)
    }
  }

  function multiselect_current_node () {
    if (!last_clicked_node || selection_flag === false) return

    // IMPORTANT FIX!!!!! : synthetic event object for compatibility with existing functions
    const synthetic_event = { ctrlKey: true, metaKey: false, shiftKey: false }

    if (mode === 'search' && search_query) {
      search_select_node(synthetic_event, last_clicked_node)
    } else {
      select_node(synthetic_event, last_clicked_node)
    }
  }

  function select_between_current_node () {
    if (!last_clicked_node || selection_flag === false) return

    if (!select_between_enabled) {
      // Enable select between mode and set first node
      select_between_enabled = true
      select_between_first_node = last_clicked_node
      update_drive_state({ type: 'mode/select_between_enabled', message: true })
      render_menubar()
    } else {
      // Complete the select between operation
      const synthetic_event = { ctrlKey: false, metaKey: false, shiftKey: true }

      if (mode === 'search' && search_query) {
        search_select_node(synthetic_event, last_clicked_node)
      } else {
        select_node(synthetic_event, last_clicked_node)
      }
    }
  }

  function scroll_to_node (instance_path) {
    const node_index = view.findIndex(node => node.instance_path === instance_path)
    if (node_index === -1 || !node_height) return

    const target_scroll_top = node_index * node_height
    const container_height = container.clientHeight
    const current_scroll_top = container.scrollTop

    // Only scroll if the node is not fully visible
    if (target_scroll_top < current_scroll_top || target_scroll_top + node_height > current_scroll_top + container_height) {
      const centered_scroll_top = target_scroll_top - (container_height / 2) + (node_height / 2)
      container.scrollTop = Math.max(0, centered_scroll_top)

      vertical_scroll_value = container.scrollTop
      drive_updated_by_scroll = true
      update_drive_state({ type: 'runtime/vertical_scroll_value', message: vertical_scroll_value })
    }
  }

  function jump_to_next_duplicate ({ base_path, current_instance_path }) {
    if (hubs_flag === 'default') {
      cycle_to_next_duplicate(base_path, current_instance_path)
    }
  }

  /******************************************************************************
  UNDO FUNCTIONALITY
    - Implements undo functionality to revert drive state changes
  ******************************************************************************/
  async function undo (steps = 1) {
    if (undo_stack.length === 0) {
      console.warn('No actions to undo')
      return
    }

    const actions_to_undo = Math.min(steps, undo_stack.length)
    console.log(`Undoing ${actions_to_undo} action(s)`)

    // Pop the specified number of actions from the stack
    const snapshots_to_restore = []
    for (let i = 0; i < actions_to_undo; i++) {
      const snapshot = undo_stack.pop()
      if (snapshot) snapshots_to_restore.push(snapshot)
    }

    // Restore the last snapshot's state
    if (snapshots_to_restore.length > 0) {
      const snapshot = snapshots_to_restore[snapshots_to_restore.length - 1]

      try {
        // Restore the state WITHOUT setting drive_updated_by_undo flag
        // This allows onbatch to process the change and update the UI
        await drive.put(`${snapshot.type}.json`, snapshot.value)

        // Update the undo stack in drive (with flag to prevent tracking this update)
        // drive_updated_by_undo = true
        await drive.put('undo/stack.json', JSON.stringify(undo_stack))

        console.log(`Undo completed: restored ${snapshot.type} to previous state`)

        // Re-render menubar to update undo button count
        render_menubar()
      } catch (e) {
        console.error('Failed to undo action:', e)
      }
    }
  }
}

/******************************************************************************
  FALLBACK CONFIGURATION
    - This provides the default data and API configuration for the component,
      following the pattern described in `instructions.md`.
    - It defines the default datasets (`entries`, `style`, `runtime`) and their
      initial values.
  ******************************************************************************/
function fallback_module () {
  return {
    api: fallback_instance
  }
  function fallback_instance () {
    return {
      drive: {
        'style/': {
          'theme.css': {
            $ref: 'theme.css'
          }
        },
        'runtime/': {
          'node_height.json': { raw: '16' },
          'vertical_scroll_value.json': { raw: '0' },
          'horizontal_scroll_value.json': { raw: '0' },
          'selected_instance_paths.json': { raw: '[]' },
          'confirmed_selected.json': { raw: '[]' },
          'instance_states.json': { raw: '{}' },
          'search_entry_states.json': { raw: '{}' },
          'last_clicked_node.json': { raw: 'null' },
          'view_order_tracking.json': { raw: '{}' }
        },
        'mode/': {
          'current_mode.json': { raw: '"menubar"' },
          'previous_mode.json': { raw: '"menubar"' },
          'search_query.json': { raw: '""' },
          'multi_select_enabled.json': { raw: 'false' },
          'select_between_enabled.json': { raw: 'false' }
        },
        'flags/': {
          'hubs.json': { raw: '"default"' },
          'selection.json': { raw: 'true' },
          'recursive_collapse.json': { raw: 'true' }
        },
        'keybinds/': {
          'navigation.json': {
            raw: JSON.stringify({
              ArrowUp: 'navigate_up_current_node',
              ArrowDown: 'navigate_down_current_node',
              'Control+ArrowDown': 'toggle_subs_for_current_node',
              'Control+ArrowUp': 'toggle_hubs_for_current_node',
              'Alt+s': 'multiselect_current_node',
              'Alt+b': 'select_between_current_node',
              'Control+m': 'toggle_search_mode',
              'Alt+j': 'jump_to_next_duplicate'
            })
          }
        },
        'undo/': {
          'stack.json': { raw: '[]' }
        }
      }
    }
  }
}

}).call(this)}).call(this,"/node_modules/graph-explorer/lib/graph_explorer.js")
},{"STATE":4}],7:[function(require,module,exports){
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

},{}],8:[function(require,module,exports){
/* global vault */
const news = require('news')

// Initialize with datashell vault/api
// The vault is passed globally by datashell loader or available via window/global
const app = news(vault)
document.body.append(app)

},{"news":10}],9:[function(require,module,exports){
// graphdb.js
module.exports = graphdb

function graphdb(entries) {
    if (!entries || typeof entries !== 'object') {
        console.warn('[graphdb] Invalid entries provided, using empty object')
        entries = {}
    }

    const api = {
        get,
        has,
        keys,
        is_empty,
        root,
        raw
    }

    return api

    function get(path) {
        return entries[path] || null
    }

    function has(path) {
        return path in entries
    }

    function keys() {
        return Object.keys(entries)
    }

    function is_empty() {
        return Object.keys(entries).length === 0
    }

    function root() {
        return entries['/'] || null
    }

    function raw() {
        return entries
    }
}

},{}],10:[function(require,module,exports){
(function (__filename){(function (){
const blog_app = require('../../../lib/node_modules/p2p-news-app')
const wrapper = require('./wrapper')
const STATE = require('STATE')
const statedb = STATE(__filename)
const { get } = statedb(fallback_module)

module.exports = function news_app(vault) {
    const container = document.createElement('div')
    container.className = 'app-container'


    const styleEl = document.createElement('style')
    styleEl.textContent = `
    body {
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      height: 100vh;
      display: flex;
      overflow: hidden;
    }

    .app-container {
      display: flex;
      width: 100%;
      height: 100%;
    }

    .sidebar {
      width: 300px;
      border-right: 1px solid #e0e0e0;
      background: #f9f9f9;
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
    }

    .main-content {
      flex: 1;
      padding: 20px;
      overflow-y: auto;
      background: #fff;
    }

    .loading {
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100%;
      color: #666;
    }
  `
    document.head.appendChild(styleEl)


    const sidebar = document.createElement('div')
    sidebar.className = 'sidebar'
    container.appendChild(sidebar)


    const main = document.createElement('div')
    main.className = 'main-content'
    main.innerHTML = '<h1>Select a feed to view posts</h1>'
    container.appendChild(main)


    init(vault, sidebar, main)

    return container
}

async function init(vault, sidebarEl, mainEl) {
    try {

        const api = blog_app(vault)


        let username = localStorage.getItem('username')
        if (!username) {
            username = prompt('Enter your username:')
            if (username) localStorage.setItem('username', username)
            else return
        }


        await api.init_blog({ username })

        const get_entries = async () => {
            const entries = {
                '/': { name: 'P2P News', type: 'root', subs: ['/my-stories', '/feeds', '/lists', '/discover'], hubs: [] },
                '/my-stories': { name: 'My Stories', type: 'folder', subs: [] },
                '/feeds': { name: 'Feeds', type: 'folder', subs: [] },
                '/lists': { name: 'Lists', type: 'folder', subs: [] },
                '/discover': { name: 'Discover', type: 'folder', subs: [] }
            }


            const peer_blogs = await api.get_peer_blogs()

            for (const [key, blog] of peer_blogs) {
                const path = `/feeds/${key}`
                const profile = await api.get_profile(key)
                const name = profile ? profile.name : blog.username

                entries['/feeds'].subs.push(path)
                entries[path] = {
                    name: name,
                    type: 'feed',
                    subs: []
                }


                if (blog.posts) {
                    blog.posts.forEach((post, index) => {
                        const post_path = `${path}/${index}`
                        entries[path].subs.push(post_path)
                        entries[post_path] = {
                            name: post.title,
                            type: 'post',
                            data: post
                        }
                    })
                }
            }


            const my_posts = await api.get_my_posts()
            my_posts.forEach((post, index) => {
                const path = `/my-stories/${index}`
                entries['/my-stories'].subs.push(path)
                entries[path] = {
                    name: post.title,
                    type: 'post',
                    data: post
                }
            })

            return entries
        }

        const { id, sdb } = await get()
        const { drive } = sdb


        const entries = await get_entries()

        await drive.put('entries/entries.json', JSON.stringify(entries))


        const sidebar_component = await wrapper({
            id: 'sidebar',
            sid: id,
            ids: { up: 'host' }
        }, (send) => {
            return (msg) => {
                console.log('Host received:', msg)
            }
        })

        sidebarEl.appendChild(sidebar_component)


        api.on_update(async () => {
            console.log('Data updated, refreshing sidebar...')
            const updated_entries = await get_entries()
            await drive.put('entries/entries.json', JSON.stringify(updated_entries))
        })

    } catch (err) {
        console.error('Error initializing news app:', err)
        mainEl.innerHTML = `<p style="color:red">Error: ${err.message}</p>`
    }
}

function fallback_module() {
    return {
        _: {
            './wrapper': { $: '' }
        },
        api: fallback_instance
    }

    function fallback_instance() {
        return {
            _: {
                './wrapper': { $: '' }
            },
            drive: {
                'entries/': {},
                'theme/': {}
            }
        }
    }
}

}).call(this)}).call(this,"/web/node_modules/news/index.js")
},{"../../../lib/node_modules/p2p-news-app":1,"./wrapper":11,"STATE":4}],11:[function(require,module,exports){
(function (__filename){(function (){
let STATE
try {
    STATE = require('STATE')
} catch (e) {
    STATE = window.STATE
}
if (!STATE || typeof STATE !== 'function') {
    if (window.STATE) STATE = window.STATE
    else console.warn('STATE module not found via require or window')
}

const statedb = STATE ? STATE(__filename) : null
const { get } = statedb ? statedb(fallback_module) : { get: async () => ({ id: 0, sdb: { drive: { get: async () => null }, watch: async () => [] } }) }
const graph_explorer = require('graph-explorer')
const graphdb = require('./graphdb')

module.exports = my_component_with_graph

async function my_component_with_graph(opts, protocol) {
    const { id, sdb } = await get(opts.sid)
    const { drive } = sdb

    const ids = opts.ids
    if (!ids || !ids.up) {
        // throw new Error(`Component ${__filename} requires ids.up to be provided`)
    }

    const by = id
    let db = null
    let send_to_graph_explorer = null
    let mid = 0

    const on = {
        theme: inject,
        entries: on_entries
    }

    const el = document.createElement('div')
    el.style.height = '100%'
    el.style.width = '100%'
    const shadow = el.attachShadow({ mode: 'closed' })
    const sheet = new CSSStyleSheet()
    shadow.adoptedStyleSheets = [sheet]

    const subs = await sdb.watch(onbatch)
    const explorer_el = await graph_explorer(subs[0], graph_explorer_protocol)
    shadow.append(explorer_el)

    return el

    async function onbatch(batch) {
        for (const { type, paths } of batch) {
            const data = await Promise.all(paths.map(path => drive.get(path).then(file => file ? file.raw : null)))
            const valid_data = data.filter(d => d !== null)
            if (valid_data.length > 0) {
                on[type] && on[type](valid_data)
            }
        }
    }

    function inject(data) {
        sheet.replaceSync(data.join('\n'))
    }

    function on_entries(data) {
        if (!data || !data[0]) {
            // console.error('Entries data is missing or empty.')
            db = graphdb({})
            notify_db_initialized({})
            return
        }

        let parsed_data
        try {
            parsed_data = typeof data[0] === 'string' ? JSON.parse(data[0]) : data[0]
        } catch (e) {
            console.error('Failed to parse entries data:', e)
            parsed_data = {}
        }

        if (typeof parsed_data !== 'object' || !parsed_data) {
            console.error('Parsed entries data is not a valid object.')
            parsed_data = {}
        }

        db = graphdb(parsed_data)
        notify_db_initialized(parsed_data)
    }

    function notify_db_initialized(entries) {
        if (send_to_graph_explorer) {
            const head = [by, 'graph_explorer', mid++]
            send_to_graph_explorer({
                head,
                type: 'db_initialized',
                data: { entries }
            })
        }
    }

    function graph_explorer_protocol(send) {
        send_to_graph_explorer = send
        return on_graph_explorer_message

        function on_graph_explorer_message(msg) {
            const { type } = msg
            if (type.startsWith('db_')) {
                handle_db_request(msg, send)
            }
        }

        function handle_db_request(request_msg, send) {
            const { head: request_head, type: operation, data: params } = request_msg
            let result

            if (!db) {
                // console.error('[my_component] Database not initialized yet')
                send_response(request_head, null)
                return
            }

            if (operation === 'db_get') {
                result = db.get(params.path)
            } else if (operation === 'db_has') {
                result = db.has(params.path)
            } else if (operation === 'db_is_empty') {
                result = db.is_empty()
            } else if (operation === 'db_root') {
                result = db.root()
            } else if (operation === 'db_keys') {
                result = db.keys()
            } else if (operation === 'db_raw') {
                result = db.raw()
            } else {
                console.warn('[my_component] Unknown db operation:', operation)
                result = null
            }

            send_response(request_head, result)

            function send_response(request_head, result) {
                const response_head = [by, 'graph_explorer', mid++]
                send({
                    head: response_head,
                    refs: { cause: request_head },
                    type: 'db_response',
                    data: { result }
                })
            }
        }
    }
}

function fallback_module() {
    return {
        _: {
            'graph-explorer': { $: '' },
            './graphdb': { $: '' }
        },
        api: fallback_instance
    }

    function fallback_instance() {
        return {
            _: {
                'graph-explorer': {
                    $: '',
                    0: '',
                    mapping: {
                        style: 'theme',
                        runtime: 'runtime',
                        mode: 'mode',
                        flags: 'flags',
                        keybinds: 'keybinds',
                        undo: 'undo'
                    }
                },
                './graphdb': {
                    $: ''
                }
            },
            drive: {
                'theme/': {
                    'style.css': {
                        raw: `
              :host {
                display: block;
                height: 100%;
                width: 100%;
              }
              .graph-container {
                color: #abb2bf;
                background-color: #282c34;
                padding: 10px;
                height: 100vh;
                overflow: auto;
              }
              .node {
                display: flex;
                align-items: center;
                white-space: nowrap;
                cursor: default;
                height: 22px;
              }
              .clickable {
                cursor: pointer;
              }
              .node.type-folder > .icon::before { content: '📁'; }
              .node.type-js-file > .icon::before { content: '📜'; }
              .node.type-file > .icon::before { content: '📄'; }
            `
                    }
                },
                'entries/': {
                    'entries.json': {
                        $ref: 'entries.json'
                    }
                },
                'runtime/': {},
                'mode/': {},
                'flags/': {},
                'keybinds/': {},
                'undo/': {}
            }
        }
    }
}

}).call(this)}).call(this,"/web/node_modules/news/wrapper.js")
},{"./graphdb":9,"STATE":4,"graph-explorer":6}]},{},[8]);
