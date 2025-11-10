// Identity and multi-device management helper
// App-independent identity management
const b4a = require('b4a')
const { create_autodrive } = require('../../../src/node_modules/autodrive')

// emitter
function make_emitter (state = {}) {
  return { on, off, emit }
  function on (type, callback) { (state[type] = state[type] || []).push(callback) }
  function off (type, callback) { (state[type] = state[type] || [])[state[type].indexOf(callback)] = undefined }
  function emit (type, data) {
    function handle_callback (f) {
      return f && f(data)
    }
    return (state[type] = state[type] || []).map(handle_callback)
  }
}

// Global state
let store, profile_drive, events_drive, profile_store, events_store, ds_manager
const emitter = make_emitter()

// Make new identity (create new profile and events drives)
async function make (options) {
  const {
    store_instance,
    profile_namespace = 'profile',
    events_namespace = 'events'
  } = options

  store = store_instance

  // Create namespaced stores
  profile_store = store.namespace(profile_namespace)
  events_store = store.namespace(events_namespace)

  // Create new drives for new identity
  profile_drive = create_autodrive({ store: profile_store, bootstrap: null })
  events_drive = create_autodrive({ store: events_store, bootstrap: null })
  await Promise.all([profile_drive.ready(), events_drive.ready()])

  emitter.emit('update')
  
  return {
    profile_drive_key: b4a.toString(profile_drive.base.key, 'hex'),
    events_drive_key: b4a.toString(events_drive.base.key, 'hex')
  }
}

// Load existing identity (from existing profile and events drive keys)
async function load (options) {
  const {
    store_instance,
    profile_drive_key,
    events_drive_key,
    profile_namespace = 'profile',
    events_namespace = 'events'
  } = options

  if (!profile_drive_key || !events_drive_key) {
    throw new Error('profile_drive_key and events_drive_key are required for load()')
  }

  store = store_instance

  // Create namespaced stores
  profile_store = store.namespace(profile_namespace)
  events_store = store.namespace(events_namespace)

  // Load existing drives
  profile_drive = create_autodrive({ store: profile_store, bootstrap: b4a.from(profile_drive_key, 'hex') })
  events_drive = create_autodrive({ store: events_store, bootstrap: b4a.from(events_drive_key, 'hex') })
  await Promise.all([profile_drive.ready(), events_drive.ready()])

  emitter.emit('update')
  
  return {
    profile_drive_key,
    events_drive_key
  }
}

// Create default profile
async function create_default_profile (username) {
  const default_avatar = `<svg><text x="50%" y="50%" font-size="120" text-anchor="middle" dominant-baseline="middle">👤</text></svg>`
  
  await profile_drive.put('/avatar.svg', b4a.from(default_avatar))
  await profile_drive.put('/profile.json', b4a.from(JSON.stringify({
    name: username,
    avatar: '/avatar.svg'
  })))
}

// Upload avatar image
async function upload_avatar (imageData, filename) {
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

// Get profile data
async function get_profile (profile_instance = null) {
  // If string key passed, ignore it (peer profiles not supported yet)
  if (typeof profile_instance === 'string') return null
  
  const target_profile = profile_instance || profile_drive
  if (!target_profile) return null
  
  try {
    await target_profile.ready()  
    const profile_data = await target_profile.get('/profile.json')
    if (!profile_data) return null
    return JSON.parse(b4a.toString(profile_data))
  } catch (err) {
    console.error('Error getting profile:', err)
    return null
  }
}

// Get avatar content from drive
async function get_avatar_content (profile_instance = null) {
  const target_profile = profile_instance || profile_drive
  if (!target_profile) return null
  
  try {
    await target_profile.ready()
    
    // Get profile to find avatar path
    const profile = await get_profile(profile_instance)
    if (!profile || !profile.avatar) return null
    
    const avatar_data = await target_profile.get(profile.avatar)
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

// Log event to events drive
async function log_event (type, data) {
  if (!events_drive) {
    console.warn(`[log_event] Cannot log ${type} event: events_drive not initialized`)
    return
  }
  
  try {
    const event = {
      type,
      data,
      meta: {
        time: Date.now()
      }
    }
    
    const event_path = `/events/${event.meta.time}-${type}.json`
    await events_drive.put(event_path, b4a.from(JSON.stringify(event)))
    console.log(`[log_event] Logged ${type} event to events drive`)
  } catch (err) {
    console.error('Error logging event:', err)
  }
}

// Get all events from events drive
async function get_events () {
  if (!events_drive) return []
  
  try {
    await events_drive.ready()
    const events = []
    const files = await events_drive.list('/events')
    
    for (const file of files) {
      try {
        const content = await events_drive.get(file)
        if (content) {
          events.push(JSON.parse(b4a.toString(content)))
        }
      } catch (err) {
        console.error('Error reading event file:', file, err)
      }
    }
    
    return events.sort((a, b) => a.meta.time - b.meta.time)
  } catch (err) {
    console.error('Error getting events:', err)
    return []
  }
}

// Get paired devices from events drive (calculates active devices from add/remove events)
async function get_paired_devices () {
  const events = await get_events()
  const devices_map = new Map()
  let device_counter = 0 // Start at 0 so bootstrap device is Device 1
  
  // Process events in order to track add/remove
  for (const event of events) {
    if (event.type === 'add') {
      const device_id = event.data.metadata_writer
      device_counter++
      const device_name = `Device ${device_counter}`
      
      // Build device object dynamically with ALL writer keys from event data
      const device = {
        name: device_name,
        timestamp: event.meta.time,
        added_date: new Date(event.meta.time).toLocaleString()
      }
      
      // Copy all writer keys from event data
      for (const [key, value] of Object.entries(event.data)) {
        if (key.endsWith('_writer')) {
          device[key] = value
        }
      }
      
      devices_map.set(device_id, device)
    } else if (event.type === 'remove') {
      const device_id = event.data.metadata_writer
      devices_map.delete(device_id)
    }
  }
  
  return Array.from(devices_map.values())
}

// Get device name by metadata writer key
async function get_device_name (metadata_writer_key) {
  const devices = await get_paired_devices()
  const device = devices.find(d => d.metadata_writer === metadata_writer_key)
  return device ? device.name : null
}

// Remove device by removing writer access from all structures (dynamic)
async function remove_device (device) {
  if (!ds_manager) {
    console.error('Datastructure manager not initialized')
    return false
  }
  
  try {
    // Dynamically remove writers from ALL structures
    const structure_names = ds_manager.get_names()
    const removal_data = {}
    
    for (const name of structure_names) {
      const writer_key_name = `${name}_writer`
      const writer_key = device[writer_key_name]
      
      if (writer_key) {
        removal_data[writer_key_name] = writer_key
        
        try {
          await ds_manager.remove_writer(name, writer_key)
          console.log(`Removed writer from ${name}`)
        } catch (err) {
          console.warn(`Failed to remove writer from ${name}:`, err.message)
        }
      }
    }
    
    // Log the removal event with all writer keys
    await log_event('remove', removal_data)
    
    console.log('Device removed successfully')
    emitter.emit('update')
    return true
  } catch (err) {
    console.error('Error removing device:', err)
    return false
  }
}

// Get raw data from any structure (dynamic with ds_manager)
async function get_raw_data (structure_name) {
  if (!ds_manager) return 'Datastructure manager not initialized'
  
  const structure = ds_manager.get(structure_name)
  if (!structure) return `Structure '${structure_name}' not found`
  
  const config = ds_manager.get_config(structure_name)
  
  try {
    if (config.type === 'autobase') {
      // For autobase: show all entries
      await structure.ready()
      if (structure.view.length === 0) return `Autobase '${structure_name}' is empty`
      
      const entries = []
      for (let i = 0; i < structure.view.length; i++) {
        try {
          const raw = await structure.view.get(i)
          const parsed = JSON.parse(raw)
          entries.push(`[${i}] ${JSON.stringify(parsed, null, 2)}`)
        } catch (err) {
          entries.push(`[${i}] Error: ${err.message}`)
        }
      }
      return entries.join('\n\n')
      
    } else if (config.type === 'autodrive') {
      // For autodrive: list all files
      await structure.ready()
      const files = []
      
      try {
        const list = await structure.list('/')
        if (list.length === 0) return `Autodrive '${structure_name}' is empty`
        
        for (const file of list) {
          try {
            const content = await structure.get(file)
            files.push(`${file}:\n${content ? b4a.toString(content) : 'null'}`)
          } catch (err) {
            files.push(`${file}: Error: ${err.message}`)
          }
        }
      } catch (err) {
        return `List error: ${err.message}`
      }
      
      return files.join('\n\n---\n\n')
    }
    
    return `Unknown structure type: ${config.type}`
  } catch (err) {
    return `Error reading ${structure_name}: ${err.message}`
  }
}

// Unified function to set drive and store
function set_drive (type, drive, store_instance, setup_events_sync_callback) {
  if (type === 'profile') {
    profile_drive = drive
    profile_store = store_instance
  } else if (type === 'events') {
    events_drive = drive
    events_store = store_instance
    
    // Setup event sync listeners if callback provided
    if (setup_events_sync_callback) {
      setup_events_sync_callback()
    }
  }
  
  emitter.emit('update')
}

// Convenience wrappers
const set_profile_drive = (drive, store_instance) => set_drive('profile', drive, store_instance)
const set_events_drive = (drive, store_instance, setup_callback) => set_drive('events', drive, store_instance, setup_callback)

// Set datastructure manager for dynamic raw data access
const set_ds_manager = (manager) => {
  ds_manager = manager
}

function handle_update_callback (cb) {
  return emitter.on('update', cb)
}

module.exports = {
  // Core identity functions (app-independent)
  make,
  load,
  
  // Profile management
  create_default_profile,
  upload_avatar,
  get_profile,
  get_avatar_content,
  
  // Events and device management
  log_event,
  get_events,
  get_paired_devices,
  get_device_name,
  remove_device,
  
  // Debugging
  get_raw_data,
  
  // Drive setters (for pairing)
  set_profile_drive,
  set_events_drive,
  set_ds_manager,
  
  // Getters
  get_profile_drive: () => profile_drive,
  get_events_drive: () => events_drive,
  get_profile_store: () => profile_store,
  get_events_store: () => events_store,
  
  // Events
  on_update: handle_update_callback
}
