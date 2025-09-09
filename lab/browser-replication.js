const b4a = require('b4a')
const Hyperswarm = require('hyperswarm')
const DHT = require('@hyperswarm/dht-relay')
const Stream = require('@hyperswarm/dht-relay/ws')
const BlindPairing = require('blind-pairing')
const Corestore = require('corestore')
const RAW = require('random-access-memory')
const Autobase = require('autobase')
const { create_autodrive } = require('../src/node_modules/autodrive')
const extend = require('@geut/sodium-javascript-plus/extend')
const sodium = extend(require('sodium-universal'))

const relay_url = 'ws://localhost:8080'

let device1 = {}
let device2 = {}

// Create autobase with blog-like config
function create_blog_autobase(store_or_core, bootstrap_key) {
  return new Autobase(store_or_core, bootstrap_key, {
    valueEncoding: 'json',
    open: (store) => store.get({ name: 'blog-view' }),
    apply: async (batch, view, base) => {
      for (const entry of batch) {
        if (entry.value?.addWriter) {
          const writer_key = typeof entry.value.addWriter === 'string' 
            ? b4a.from(entry.value.addWriter, 'hex') 
            : entry.value.addWriter
          await base.addWriter(writer_key, { isIndexer: true })
        } else if (entry.value) {
          await view.append(entry.value)
        }
      }
    }
  })
}

// Setup network connection
async function setup_network(device_name) {
  console.log(`\n=== ${device_name}: Setting up network ===`)
  
  const socket = new WebSocket(relay_url)
  
  return new Promise((resolve, reject) => {
    socket.addEventListener('error', (err) => {
      console.error(`${device_name}: Relay connection failed:`, err.message)
      reject(err)
    })
    
    socket.addEventListener('open', async () => {
      console.log(`${device_name}: Connected to relay`)
      
      const dht = new DHT(new Stream(true, socket))
      const swarm = new Hyperswarm({ dht })
      const blind_pairing = new BlindPairing(swarm)
      
      swarm.on('connection', (conn, info) => {
        console.log(`${device_name}: Peer connected`)
        
        conn.on('error', (error) => {
          console.log(`${device_name}: Peer error:`, error.message)
        })
        
        conn.on('close', () => {
          console.log(`${device_name}: Peer disconnected`)
        })
      })
      
      await blind_pairing.ready()
      
      // Join the topic
      const topic = b4a.from('test-pairing-topic')
      await swarm.join(topic).flushed()
      console.log(`${device_name}: Joined network`)
      
      resolve({ swarm, blind_pairing })
    })
  })
}

// Device 1: Create autobase and autodrive, then create invite
async function device1_create_and_invite() {
  console.log('\n=== DEVICE 1: Creating autobase, autodrive and invite ===')
  
  // Create stores
  const metadata_store = new Corestore(RAW.reusable('device1-metadata'))
  const drive_store = new Corestore(RAW.reusable('device1-drive'))
  
  // Create autobase and autodrive
  device1.autobase = create_blog_autobase(metadata_store)
  device1.drive = create_autodrive(drive_store)
  
  await Promise.all([device1.autobase.ready(), device1.drive.ready()])
  console.log('DEVICE 1: ✅ Autobase ready - writable:', device1.autobase.writable)
  console.log('DEVICE 1: 🔑 Autobase key:', b4a.toString(device1.autobase.key, 'hex').slice(0, 16) + '...')
  console.log('DEVICE 1: ✅ Autodrive ready - base key:', b4a.toString(device1.drive.base.key, 'hex').slice(0, 16) + '...')
  console.log('DEVICE 1: 🔑 Autodrive key:', b4a.toString(device1.drive.base.key, 'hex').slice(0, 16) + '...')
  
  // Initialize with some data
  const init_data = {
    type: 'blog-init',
    drive_key: b4a.toString(device1.drive.base.key, 'hex'),
    title: 'Device 1 Blog',
    username: 'device1'
  }
  await device1.autobase.append(init_data)
  await device1.autobase.update()
  console.log('DEVICE 1: ✅ Added initial metadata to autobase')
  
  // Setup network
  const network = await setup_network('DEVICE 1')
  device1.swarm = network.swarm
  device1.blind_pairing = network.blind_pairing
  
  // Setup CORESTORE replication like autopass.js
  console.log('DEVICE 1: Setting up CORESTORE replication')
  device1.swarm.on('connection', (conn) => {
    console.log('DEVICE 1: Replicating CORESTORE on connection')
    metadata_store.replicate(conn)
    drive_store.replicate(conn)
  })
  
  // Create invite
  const invite = BlindPairing.createInvite(device1.drive.base.key)
  const invite_code = b4a.toString(invite.invite, 'base64')
  console.log('DEVICE 1: Invite created, length:', invite_code.length)
  
  // Store for device2
  window.test_invite = invite_code
  
  // Setup member to handle joins
  device1.member = device1.blind_pairing.addMember({
    discoveryKey: device1.drive.base.discoveryKey,
    onadd: async (request) => {
      try {
        console.log('DEVICE 1: Processing join request')
        
        await request.open(invite.publicKey)
        const user_data = request.userData
        
        // Parse writer keys (32 bytes each)
        const metadata_writer_key = user_data.slice(0, 32)
        const drive_writer_key = user_data.slice(32, 64)
        
        // Add writers
        const writerHex = b4a.toString(metadata_writer_key, 'hex')
        await device1.autobase.append({ addWriter: writerHex })
        await device1.autobase.update()
        console.log('DEVICE 1: ✅ Added metadata writer to autobase')
        
        const drive_writer_hex = b4a.toString(drive_writer_key, 'hex')
        await device1.drive.add_writer(drive_writer_hex)
        console.log('DEVICE 1: ✅ Added drive writer to autodrive')
        
        console.log('DEVICE 1: Confirming pairing')
        request.confirm({ 
          key: device1.drive.base.key,
          encryptionKey: device1.autobase.key
        })
        
        console.log('DEVICE 1: Pairing completed successfully!')
        
      } catch (error) {
        console.error('DEVICE 1: Pairing error:', error)
      }
    }
  })
  
  await device1.member.ready()
  device1.member.announce()
  console.log('DEVICE 1: Ready for pairing')
}

// Device 2: Join using invite
async function device2_join() {
  console.log('\n=== DEVICE 2: Joining via invite ===')
  
  // Setup network first
  const network = await setup_network('DEVICE 2')
  device2.swarm = network.swarm
  device2.blind_pairing = network.blind_pairing
  
  // Get invite
  const invite_code = window.test_invite
  console.log('DEVICE 2: Got invite, length:', invite_code.length)
  
  const invite_buffer = b4a.from(invite_code, 'base64')
  
  // Create separate stores
  const metadata_store = new Corestore(RAW.reusable('device2-metadata'))
  const drive_store = new Corestore(RAW.reusable('device2-drive'))
  
  // Get writer keys using getLocalCore (like p2p-cli.js)
  const { getLocalCore } = require('../src/node_modules/autodrive/index.js')
  
  const metadata_core = getLocalCore(metadata_store)
  const drive_core = getLocalCore(drive_store)
  
  await Promise.all([metadata_core.ready(), drive_core.ready()])
  console.log('DEVICE 2: ✅ Generated writer keys using getLocalCore')
  
  const metadata_writer_key = metadata_core.key
  const drive_writer_key = drive_core.key
  
  // Close the cores since we only needed the keys
  await Promise.all([metadata_core.close(), drive_core.close()])
  
  // Concatenate keys for pairing
  const user_data = b4a.concat([metadata_writer_key, drive_writer_key])
  
  return new Promise((resolve, reject) => {
    device2.candidate = device2.blind_pairing.addCandidate({
      invite: invite_buffer,
      userData: user_data,
      onadd: async (result) => {
        try {
          console.log('DEVICE 2: Join accepted!')
          console.log('DEVICE 2: Received drive key:', b4a.toString(result.key, 'hex').slice(0, 16) + '...')
          console.log('DEVICE 2: Received autobase key:', b4a.toString(result.encryptionKey, 'hex').slice(0, 16) + '...')
          
          // NOW create autobase and autodrive with the SHARED keys from Device 1
          device2.autobase = create_blog_autobase(metadata_store, result.encryptionKey)
          device2.drive = create_autodrive(drive_store, result.key)
          
          // Store the writer keys for writability checks
          device2.metadata_writer_key = metadata_writer_key
          device2.drive_writer_key = drive_writer_key
          
          await Promise.all([device2.autobase.ready(), device2.drive.ready()])
          console.log('DEVICE 2: ✅ Joined shared autobase - key:', b4a.toString(device2.autobase.key, 'hex').slice(0, 16) + '...')
          console.log('DEVICE 2: 🔑 My autobase key:', b4a.toString(device2.autobase.key, 'hex').slice(0, 16) + '...')
          console.log('DEVICE 2: ✅ Joined shared autodrive - key:', b4a.toString(device2.drive.base.key, 'hex').slice(0, 16) + '...')
          console.log('DEVICE 2: 🔑 My autodrive key:', b4a.toString(device2.drive.base.key, 'hex').slice(0, 16) + '...')
          
          // Compare keys to confirm they match
          const keys_match_autobase = b4a.equals(device1.autobase.key, device2.autobase.key)
          const keys_match_autodrive = b4a.equals(device1.drive.base.key, device2.drive.base.key)
          console.log('DEVICE 2: ✅ Autobase keys match Device 1:', keys_match_autobase)
          console.log('DEVICE 2: ✅ Autodrive keys match Device 1:', keys_match_autodrive)
          
          // Setup replication for new connections
          device2.swarm.on('connection', (conn) => {
            metadata_store.replicate(conn)
            drive_store.replicate(conn)
          })
          
          // Replicate with existing connections
          for (const conn of device2.swarm.connections) {
            metadata_store.replicate(conn)
            drive_store.replicate(conn)
          }
          
          // Wait for both systems to be writable
          console.log('DEVICE 2: Waiting for systems to become writable...')
          
          const wait_for_writable = async () => {
            for (let i = 0; i < 20; i++) { // Wait up to 2 seconds
              await device2.autobase.update()
              const autobase_writable = device2.autobase.writable
              const autodrive_writable = device2.drive.is_writer(device2.drive_writer_key)
              
              if (autobase_writable && autodrive_writable) {
                console.log('DEVICE 2: ✅ Both systems now writable!')
                return
              }
              
              await new Promise(resolve => setTimeout(resolve, 100)) // Wait 100ms
            }
            
            // Final check and report status
            const final_autobase = device2.autobase.writable
            const final_autodrive = device2.drive.is_writer(device2.drive_writer_key)
            console.log('DEVICE 2: Final status - Autobase:', final_autobase, 'Autodrive:', final_autodrive)
          }
          
          await wait_for_writable()
          
          resolve()
          
        } catch (error) {
          console.error('DEVICE 2: Join error:', error)
          reject(error)
        }
      }
    })
    
    device2.candidate.ready().catch(reject)
  })
}

// Setup replication between devices (CORESTORE level like autopass)
async function setup_replication() {
  console.log('\n=== Setting up CORESTORE replication ===')
  
  // Device 1 already has corestore replication setup during creation
  // Device 2 already has corestore replication setup during pairing
  
  console.log('CORESTORE replication setup complete')
}

// Test writing and reading
async function test_writing() {
  console.log('\n=== Testing writing and replication ===')
  
  // Wait a bit for replication to establish
  await new Promise(resolve => setTimeout(resolve, 2000))
  
  // Device 1 writes to autobase and autodrive
  console.log('DEVICE 1: ✍️ Writing metadata to autobase')
  await device1.autobase.append({
    type: 'blog-post', 
    title: 'Post from Device 1',
    content: 'Hello from device 1!',
    timestamp: Date.now()
  })
  await device1.autobase.update()
  console.log('DEVICE 1: ✅ Metadata written to autobase')
  
  console.log('DEVICE 1: ✍️ Writing file to autodrive')
  await device1.drive.put('/test1.txt', b4a.from('File from device 1'))
  console.log('DEVICE 1: ✅ File written to autodrive')
  
  // Wait for replication
  await new Promise(resolve => setTimeout(resolve, 1000))
  
  // Device 2 reads and writes
  await device2.autobase.update()
  const file1 = await device2.drive.get('/test1.txt')
  console.log('DEVICE 2: Read file:', file1 ? b4a.toString(file1) : 'null')
  
  // Device 2 writes to autobase
  console.log('DEVICE 2: ✍️ Writing metadata to autobase')
  await device2.autobase.append({
    type: 'blog-post', 
    title: 'Post from Device 2',
    content: 'Hello from device 2!',
    timestamp: Date.now()
  })
  await device2.autobase.update()
  console.log('DEVICE 2: ✅ Metadata written to autobase!')
  
  // Device 2 writes to autodrive
  console.log('DEVICE 2: ✍️ Writing file to autodrive')
  await device2.drive.put('/test2.txt', b4a.from('File from device 2'))
  console.log('DEVICE 2: ✅ File written to autodrive!')
  
  // Final check - device 1 reads device 2's writes
  await new Promise(resolve => setTimeout(resolve, 1000))
  console.log('DEVICE 1: 🔍 Reading replicated data from device 2')
  await device1.autobase.update()
  const file2 = await device1.drive.get('/test2.txt')
  console.log('DEVICE 1: ✅ Successfully read device 2 file:', file2 ? b4a.toString(file2) : 'null')
}

// Main test function
async function run_test() {
  console.log('🧪 Starting Blind Pairing + Multi-Writer Test')
  
  try {
    await device1_create_and_invite()
    await device2_join()
    await setup_replication()
    await test_writing()
    
    console.log('\n✅ Test completed!')
    
  } catch (error) {
    console.error('❌ Test failed:', error)
  }
}

// Auto-start test
setTimeout(run_test, 1000)
