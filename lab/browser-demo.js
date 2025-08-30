const { create_autodrive } = require('../src/node_modules/autodrive')
const corestore = require('corestore')
const b4a = require('b4a')
const Hyperswarm = require('hyperswarm')
const crypto = require('hypercore-crypto')
const ram = require('random-access-memory')
const BlindPairing = require('blind-pairing')
const DHT = require('@hyperswarm/dht-relay')
const Stream = require('@hyperswarm/dht-relay/ws')
const extend = require('@geut/sodium-javascript-plus/extend')
const sodium = extend(require('sodium-universal'))



const relay_url = 'ws://localhost:8080'

let device1 = {}, device2 = {}

async function setup_network(device_name) {
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
      const topic = crypto.hash(b4a.from('p2p-news-app-topic'))
      await swarm.join(topic).flushed()
      console.log(`${device_name}: Joined network`)
      
      resolve({ swarm, blind_pairing })
    })
  })
}

async function device1_create_identity() {
  console.log('\n=== DEVICE 1: Creating Identity ===')
  
  // Create autodrive
  device1.drive = create_autodrive(new corestore(ram))
  await device1.drive.ready()
  console.log('DEVICE 1: Drive created')
  
  // Setup network
  const network = await setup_network('DEVICE 1')
  device1.swarm = network.swarm
  device1.blind_pairing = network.blind_pairing
  
  console.log('DEVICE 1: Creating invite')
  // Create invite
  const invite = BlindPairing.createInvite(device1.drive.base.key)
  const invite_code = b4a.toString(invite.invite, 'base64')
  console.log('DEVICE 1: Invite created')
  
  // Store for device2
  window.shared_invite = invite_code
  
  // Setup member to handle joins
  device1.current_member = device1.blind_pairing.addMember({
    discoveryKey: device1.drive.base.discoveryKey,
    onadd: async (request) => {
      try {
        await request.open(invite.publicKey)
        
        const writer_key_buffer = request.userData
        
        // Convert Uint8Array to proper hex string for autodrive compatibility
        const writer_key_hex = b4a.toString(writer_key_buffer, 'hex')
        
        await device1.drive.add_writer(writer_key_hex)
        console.log('DEVICE 1: Writer added to drive')
        
        request.confirm({ 
          key: device1.drive.base.key,
          encryptionKey: device1.drive.base.encryptionKey || null
        })
        
        console.log('DEVICE 1: Device paired successfully!')
        
      } catch (error) {
        console.error('DEVICE 1: Pairing error:', error.message)
      }
    }
  })
  
  await device1.current_member.ready()
  device1.current_member.announce()
  console.log('DEVICE 1: Ready for pairing')
}

async function device2_join_identity() {
  console.log('\n== DEVICE 2: Joining Identity ===')
  
  // Setup network
  const network = await setup_network('DEVICE 2')
  device2.swarm = network.swarm
  device2.blind_pairing = network.blind_pairing
  
  // Get invite from device1
  const invite_code = window.shared_invite
  
  
  const invite_buffer = b4a.from(invite_code, 'base64')
  
  // Create local store and get writer key
  const store = new corestore(ram)
  
  const { getLocalCore } = require('../src/node_modules/autodrive')
  const core = getLocalCore(store)
  await core.ready()
  const my_writer_key = core.key
  await core.close()
  
  // Send only the writer key
  const user_data = my_writer_key
  
  // Create candidate to join using the invite
  device2.current_candidate = device2.blind_pairing.addCandidate({
    invite: invite_buffer,
    userData: user_data,
    onadd: async (result) => {
      console.log('DEVICE 2: Joining shared drive')
      
      // Connect to the shared drive
      device2.drive = create_autodrive(store, result.key)
      await device2.drive.ready()
      
      console.log('DEVICE 2: Successfully joined drive!')
    }
  })
  
  await device2.current_candidate.ready()
}

async function start_test() {
  console.log('=== P2P News Autodrive Test Starting ===')
  
  try {
    await device1_create_identity()
    // it will join after first device joins
    await device2_join_identity()
    
  } catch (error) {
    console.error('Test failed:', error)
  }
}

// Start the test
start_test()