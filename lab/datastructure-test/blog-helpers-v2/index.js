// Blog helper v2 - uses datastructure-manager for unified data structure handling
const b4a = require('b4a')
const { create_datastructure_manager } = require('../datastructure-manager')
const identity_helper = require('../identity-helper')

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
  { name: 'events', namespace: 'blog-events', type: 'autodrive' }
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
            drive_key: init_entry.data.drive_key
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
  const { store_instance, username, drive_key, autobase_key, invite_code, swarm } = options
  
  store = store_instance
  
  // Create datastructure manager
  ds_manager = create_datastructure_manager()
  
  // Set ds_manager in identity_helper for dynamic raw data access
  identity_helper.set_ds_manager(ds_manager)
  
  // Register all structures 
  for (const config of STRUCTURES) {
    ds_manager.register({ ...config, store })
  }

  // JOINING EXISTING BLOG  All keys received from pairing
  if (invite_code && swarm) {
    // join_with_invite_and_init already initializes ALL structures with keys from pairing
    const result = await ds_manager.join_with_invite_and_init(invite_code, swarm, store)
    pairing_result = result  // Store for later retrieval
    
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
    
    // Setup identity helper
    identity_helper.set_profile_drive(profile_drive, ds_manager.get_store('profile'))
    identity_helper.set_events_drive(events_drive, ds_manager.get_store('events'))
    
  } else if (!drive_key && !autobase_key) {
    // CREATING NEW BLOG - also using the ds_manager
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
    
    identity_helper.set_profile_drive(profile_drive, ds_manager.get_store('profile'))
    identity_helper.set_events_drive(events_drive, ds_manager.get_store('events'))
    
    await identity_helper.create_default_profile(username)
    
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
    
    console.log('[blog-helpers] Device keys:', device_keys)
    
    // Only log device if it doesn't already exist (prevent duplicates on refresh)
    const existing_devices = await identity_helper.get_paired_devices()
    const device_exists = existing_devices.some(d => d.metadata_writer === device_keys.metadata_writer)
    
    if (!device_exists) {
      await identity_helper.log_event('add', device_keys)
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
    
  } else {
    // Joining existing blog
    await ds_manager.init('metadata', autobase_key)
    await ds_manager.init('drive', drive_key)
    
    const metadata = ds_manager.get('metadata')
    const drive = ds_manager.get('drive')
    
    await Promise.all([metadata.ready(), drive.ready()])
    await metadata.update()
    await drive.download('/')
    
    // Try to get profile and events keys from metadata
    if (metadata.view && metadata.view.length >= 2) {
      try {
        const extended_raw = await metadata.view.get(1)
        const extended_entry = JSON.parse(extended_raw)
        
        if (extended_entry.data?.profile_drive_key && extended_entry.data?.events_drive_key) {
          await ds_manager.init('profile', extended_entry.data.profile_drive_key)
          await ds_manager.init('events', extended_entry.data.events_drive_key)
          
          const profile_drive = ds_manager.get('profile')
          const events_drive = ds_manager.get('events')
          
          await Promise.all([profile_drive.ready(), events_drive.ready()])
          
          identity_helper.set_profile_drive(profile_drive, ds_manager.get_store('profile'))
          identity_helper.set_events_drive(events_drive, ds_manager.get_store('events'))
          
          await profile_drive.download('/')
        }
      } catch (err) {
        console.error('Error loading profile/events:', err)
      }
    }
  }

  // Setup event handlers
  const metadata = ds_manager.get('metadata')
  
  store.on('peer-autobase-key', async ({ key, key_buffer }) => {
    if (key === ds_manager.get_key('metadata')) return
    if (autobase_cache.has(key)) return
    await setup_peer_autobase(key, key_buffer)
  })

  metadata.on('update', () => emitter.emit('update'))
  
  restore_subscribed_peers()
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
        const post = JSON.parse(post_buffer.toString())
        posts.push(post)
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
const create_invite = async (swarm) => {
  const drive = ds_manager.get('drive')
  
  const { invite_code, invite, pairing_manager: pm } = await ds_manager.create_invite_with_pairing(swarm, 'drive')
  
  // Store pairing_manager for later use
  if (!pairing_manager) pairing_manager = pm
  
  // Get username from profile
  const profile = await identity_helper.get_profile()
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
      await identity_helper.log_event('add', device_keys)
    }
  })
  
  return invite_code
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

module.exports = {
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
  get_profile: identity_helper.get_profile,
  get_avatar_content: identity_helper.get_avatar_content,
  upload_avatar: identity_helper.upload_avatar,
  log_event: identity_helper.log_event,
  get_paired_devices: identity_helper.get_paired_devices,
  remove_device: identity_helper.remove_device,
  get_raw_data: identity_helper.get_raw_data,
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