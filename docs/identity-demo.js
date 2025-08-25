#!/usr/bin/env node

const { create_autodrive } = require('./autodrive')
const corestore = require('corestore')
const b4a = require('b4a')
const Hyperswarm = require('hyperswarm')
const crypto = require('hypercore-crypto')
const readline = require('readline')
const ram = require('random-access-memory')
const identity_key = require('keet-identity-key')
const BlindPairing = require('blind-pairing')
const fs = require('fs').promises

////////////////////////////////////////////////////////////////////////////////////////////////////
// GLOBAL STATE & SETUP
////////////////////////////////////////////////////////////////////////////////////////////////////

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const question = prompt => new Promise(resolve => rl.question(prompt, resolve))

let drive, swarm, identity, device_keypair, proof, blindPairing, currentMember, currentCandidate
let subscriptions = new Map()
const topic = crypto.hash(b4a.from('p2p-news-app-topic'))

////////////////////////////////////////////////////////////////////////////////////////////////////
// MAIN ENTRY POINT
////////////////////////////////////////////////////////////////////////////////////////////////////

async function main() {
  console.log('P2P News App\n1. Make Identity  2. Join Identity')
  const choice = await question('Choice: ')
  
  if (choice === '1') await create_identity()
  else if (choice === '2') await join_identity()
  else process.exit(1)
  
  await menu()
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  await cleanup()
  process.exit(0)
})

////////////////////////////////////////////////////////////////////////////////////////////////////
// IDENTITY MANAGEMENT
////////////////////////////////////////////////////////////////////////////////////////////////////

// Create a new identity with mnemonic phrase
async function create_identity() {
  const mnemonic = identity_key.generateMnemonic()
  console.log(`Save this mnemonic: ${mnemonic}`)
  
  // Generate identity and device keys
  identity = await identity_key.from({ mnemonic })
  device_keypair = crypto.keyPair()
  proof = await identity.bootstrap(device_keypair.publicKey)
  
  // Create personal drive for storing posts
  drive = create_autodrive(new corestore(ram))
  await drive.ready()
  
  console.log(`Identity created. Drive: ${drive.base.key.toString('hex')}`)
  await setup_network()
}

// Join existing identity using invite code
async function join_identity() {
  const invite_code = await question('Enter invite code: ')
  const invite_buffer = b4a.from(invite_code, 'base64')
  
  // Generate new device keypair for this device
  device_keypair = crypto.keyPair()
  
  const store = new corestore(ram)
  await setup_network()
  
  // Get our writer key for the shared drive
  const { getLocalCore } = require('./autodrive')
  const core = getLocalCore(store)
  await core.ready()
  const myWriterKey = core.key
  await core.close()
  
  // Create candidate to join using the invite
  currentCandidate = blindPairing.addCandidate({
    invite: invite_buffer,
    userData: device_keypair.publicKey, // Send our device public key for attestation
    onAttestation: async (attestation, channel) => {
      if (attestation.type !== 'identity_attestation') return
      
      try {
        // Verify the inviter's attestation that our device belongs to their identity
        const proofBuffer = Buffer.from(attestation.proof, 'base64')
        const info = identity_key.verify(proofBuffer, null, { 
          expectedDevice: device_keypair.publicKey // Verify this proof is for OUR device
        })
        
        if (info) {
          console.log('Identity attestation verified - we now belong to identity:', info.identityPublicKey.toString('hex'))
          
          // Store our identity proof for future use
          proof = proofBuffer
          identity = { identityPublicKey: info.identityPublicKey }
          
          // Send back our writer key so we can write to the shared drive
          currentCandidate.sendAttestation({
            type: 'attestation_ack',
            writerKey: myWriterKey.toString('hex')
          }, channel)
        } else {
          console.log('Identity attestation verification failed')
        }
      } catch (error) {
        console.log('Attestation error:', error.message)
        currentCandidate.sendAttestation({ type: 'attestation_error', message: error.message }, channel)
      }
    },
    onadd: async (result) => {
      console.log('Pairing successful!')
      // Connect to the shared drive
      drive = create_autodrive(store, result.key)
      await drive.ready()
      
      // Start replicating with all peers
      for (const conn of swarm.connections) {
        drive.replicate(conn)
      }
      
      console.log('Connected to shared drive!')
    }
  })
  
  await currentCandidate.ready()
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// NETWORK SETUP
////////////////////////////////////////////////////////////////////////////////////////////////////

// Set up swarm connection and blind pairing
async function setup_network() {
  // Load bootstrap nodes if available
  let bootstrap
  try { 
    bootstrap = JSON.parse(await fs.readFile('bootstrap.json', 'utf-8')) 
  } catch (e) {}
  
  // Create swarm with our device keypair
  swarm = new Hyperswarm({ keyPair: device_keypair, bootstrap })
  blindPairing = new BlindPairing(swarm)
  
  // Handle new peer connections
  swarm.on('connection', (conn, info) => {
    console.log(`Peer connected: ${info?.publicKey?.toString('hex')?.slice(0, 8) || 'unknown'}`)
    if (!conn.userData) conn.userData = { protocols: new Map() }
    
    // Replicate our drive and subscriptions
    if (drive) drive.replicate(conn)
    for (let sub_drive of subscriptions.values()) {
      sub_drive.replicate(conn)
    }
  })
  
  await blindPairing.ready()
  await swarm.join(topic).flushed()
  console.log('Joined swarm network')
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// INVITE SYSTEM
////////////////////////////////////////////////////////////////////////////////////////////////////

// Generate invite code for others to join our network
async function create_invite() {
  if (!drive) return console.log('Create identity first')
  
  const invite = BlindPairing.createInvite(drive.base.key)
  const invite_code = b4a.toString(invite.invite, 'base64')
  console.log(`Invite created: ${invite_code}`)
  
  // Clean up previous member if exists
  if (currentMember) await currentMember.close()
  
  // Set up member to handle incoming pairing requests
  currentMember = blindPairing.addMember({
    discoveryKey: drive.base.discoveryKey,
    onAttestation: async (attestation) => {
      // Handle response from candidate
      if (attestation.type === 'attestation_ack' && attestation.writerKey) {
        const writerKeyBuffer = Buffer.from(attestation.writerKey, 'hex')
        await drive.add_writer(writerKeyBuffer)
        console.log('Writer key added - peer can now post!')
      }
    },
    onadd: async (request) => {
      console.log('Received pairing request')
      try {
        // Verify the pairing request
        await request.open(invite.publicKey)
        console.log('Pairing request verified')
        
        // Create attestation that the requesting device belongs to our identity
        const attestationData = identity_key.attestDevice(request.userData, device_keypair, proof)
        
        // Confirm pairing and give access to our drive
        request.confirm({ 
          key: drive.base.key,
          encryptionKey: drive.base.encryptionKey || null
        })
        
        console.log('Pairing confirmed - sending attestation')
        
        // Send identity attestation
        const attestation = {
          type: 'identity_attestation',
          proof: attestationData.toString('base64'),
          timestamp: new Date().toISOString()
        }
        
        // Send through all available channels
        for (const ch of currentMember.ref.channels) {
          if (ch.messages[2]) {
            ch.messages[2].send(Buffer.from(JSON.stringify(attestation)))
          }
        }
        
      } catch (error) {
        console.log('Pairing failed:', error.message)
        request.deny()
      }
    }
  })
  
  await currentMember.ready()
  currentMember.announce()
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// MESSAGING SYSTEM
////////////////////////////////////////////////////////////////////////////////////////////////////

// Post a message to our drive with cryptographic signature
async function post_message() {
  if (!drive) return console.log('No drive available')
  if (!identity || !device_keypair || !proof) return console.log('No identity available')
  
  const message = await question('Message: ')
  const postData = {
    message,
    timestamp: new Date().toISOString(),
    author: identity.identityPublicKey.toString('hex').slice(0, 8), // Use identity, not drive key
    identityKey: identity.identityPublicKey.toString('hex')
  }
  
  // Sign the post with our attested device
  const postBuffer = Buffer.from(JSON.stringify(postData))
  const signature = identity_key.attestData(postBuffer, device_keypair, proof)
  
  const signedPost = {
    data: postData,
    signature: signature.toString('base64')
  }
  
  try {
    await drive.put(`/post_${Date.now()}.json`, Buffer.from(JSON.stringify(signedPost)))
    console.log('Message posted with cryptographic signature!')
  } catch (error) {
    console.log('Failed to post:', error.message)
  }
}

// Subscribe to another user's drive to see their posts
async function subscribe() {
  const name = await question('Subscription name: ')
  const key = await question('Drive key: ')
  
  try {
    const sub_drive = create_autodrive(new corestore(ram), Buffer.from(key, 'hex'))
    await sub_drive.ready()
    subscriptions.set(name, sub_drive)
    
    // Replicate with existing connections
    for (const conn of swarm.connections) {
      sub_drive.replicate(conn)
    }
    
    console.log(`Subscribed to ${name}`)
  } catch (error) {
    console.log('Subscribe failed:', error.message)
  }
}

// Display all posts from our drive and subscribed drives with signature verification
async function list_posts() {
  console.log('\nPosts:')
  
  const show_posts = async (drive_obj, title = '') => {
    if (title) console.log(`\n${title}:`)
    try {
      const files = await drive_obj.list('/')
      for await (const file of files) {
        if (file.startsWith('/post_')) {
          const content = await drive_obj.get(file)
          
          try {
            const signedPost = JSON.parse(content.toString())
            
            // Verify signature
            const postBuffer = Buffer.from(JSON.stringify(signedPost.data))
            const signatureBuffer = Buffer.from(signedPost.signature, 'base64')
            const verification = identity_key.verify(signatureBuffer, postBuffer)
            
            const verifyIcon = verification ? '[VERIFIED]' : '[INVALID]'
            const post = signedPost.data
            console.log(`${verifyIcon} [${post.timestamp}] ${post.author}: ${post.message}`)
            
            if (verification) {
              console.log(`    Identity: ${verification.identityPublicKey.toString('hex').slice(0, 16)}...`)
            } else {
              console.log(`    WARNING: Signature verification failed!`)
            }
          } catch (parseError) {
            console.log(`ERROR: Failed to parse post: ${file}`)
          }
        }
      }
    } catch (e) {
      console.log(title ? 'No posts yet' : 'No posts in main drive')
    }
  }
  
  // Show posts from main drive
  if (drive) await show_posts(drive)
  else console.log('No main drive available')
  
  // Show posts from subscribed drives
  for (let [name, sub_drive] of subscriptions) {
    await show_posts(sub_drive, name)
  }
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// USER INTERFACE
////////////////////////////////////////////////////////////////////////////////////////////////////

// Main menu loop
async function menu() {
  while (true) {
    console.log('\nMenu: 1. Post  2. Invite  3. Subscribe  4. List Posts  5. Info  6. Exit')
    const choice = await question('Choice: ')
    
    switch (choice) {
      case '1': await post_message(); break
      case '2': await create_invite(); break
      case '3': await subscribe(); break
      case '4': await list_posts(); break
      case '5': 
        // Show system info
        if (drive) {
          console.log(`Drive: ${drive.base.key.toString('hex')}`)
          console.log(`Writable: ${drive.base.writable}`)
        }
        if (identity) {
          console.log(`Identity: ${identity.identityPublicKey.toString('hex')}`)
        }
        if (device_keypair) {
          console.log(`Device: ${device_keypair.publicKey.toString('hex')}`)
        }
        console.log(`Connections: ${swarm?.connections.size || 0}`)
        break
      case '6':
        await cleanup()
        rl.close()
        process.exit(0)
      default: console.log('Invalid choice')
    }
  }
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// CLEANUP
////////////////////////////////////////////////////////////////////////////////////////////////////

// Clean shutdown of all resources
async function cleanup() {
  if (currentMember) await currentMember.close()
  if (currentCandidate) await currentCandidate.close()
  if (blindPairing) await blindPairing.close()
  if (swarm) await swarm.destroy()
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// START APPLICATION
////////////////////////////////////////////////////////////////////////////////////////////////////

main().catch(console.error)
