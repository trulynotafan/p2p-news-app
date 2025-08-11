const { create_autodrive } = require('./autodrive')
const corestore = require('corestore')
const b4a = require('b4a')
const Hyperswarm = require('hyperswarm')
const crypto = require('hypercore-crypto')
const readline = require('readline')
const ram = require('random-access-memory')
const identity_key = require('keet-identity-key')
const { MemberRequest, CandidateRequest, createInvite: make_invite } = require('blind-pairing-core')
const Protomux = require('protomux')
const c = require('compact-encoding')
const fs = require('fs').promises

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const question = prompt => new Promise(resolve => rl.question(prompt, resolve))

// Global state
let drive, swarm, identity, device_keypair, proof, candidate
let subscriptions = new Map(), invites = new Map(), pairing_channels = new Map()
const topic = crypto.hash(b4a.from('p2p-news-app-topic'))

// Create a new protomux stream if not exists, if does use it.
// This function attaches one protocol manager per peer connection to prevent communication errors.
function get_muxer(stream) {
  if (stream.userData) return stream.userData
  const protocol = Protomux.from(stream)
  stream.setKeepAlive(5000)
  return stream.userData = protocol
}

// Creates a new identity with mnemonic phrase
async function create_identity() {
  const mnemonic = identity_key.generateMnemonic()
  console.log(`\nSave this mnemonic: ${mnemonic}`)
  
  // Generate identity and device keys
  identity = await identity_key.from({ mnemonic })
  device_keypair = crypto.keyPair()
  proof = await identity.bootstrap(device_keypair.publicKey)
  
  // Create our personal drive for storing posts
  drive = create_autodrive(new corestore(ram))
  await drive.ready()
  
  console.log(`Identity created. Drive: ${drive.base.key.toString('hex')}`)
  await setup_network()
}

// Join existing identity using invite code , to add existing device to user
async function join_identity() {
  // Decode the base64 invite code that contains connection info and keys
  const invite_buffer = b4a.from(await question('Enter invite code: '), 'base64')
  // Generate new keypair for this specific device (each device has unique keys)
  device_keypair = crypto.keyPair()
  // Create a candidate request to join the inviter's identity
  // This includes our device's public key so the inviter can verify us
  candidate = new CandidateRequest(invite_buffer, device_keypair.publicKey)
  
  let writer_key_sent = false
  
  // When the inviter accepts our pairing request
  candidate.on('accepted', async (auth) => {
    // Create the shared drive using the key from inviter
    drive = create_autodrive(new corestore(ram), auth.key)
    await drive.ready()
    
    // Start replicating (syncing) the drive with all connected peers
    if (swarm) for (const conn of swarm.connections) drive.replicate(conn)
    console.log('Paired successfully!')
    
    // Send our writer key so we can post to the shared drive
    const send_writer_key = () => {
      const channel = pairing_channels.get(candidate.discoveryKey.toString('hex'))
      if (channel && !writer_key_sent) channel.messages[2].send(drive.base.local.key)
    }
    
    // Wait 2 seconds for pairing channels to be established, then try sending
    setTimeout(send_writer_key, 2000)
  })
  
  await setup_network()
}

// Set up swarm connection
async function setup_network() {
 
  // using bootstrap for faster discovery (for testing)
  let bootstrap
  try { bootstrap = JSON.parse(await fs.readFile('bootstrap.json', 'utf-8')) } catch (e) {}
  // passing our device keypair to swarm, is this correct?
  swarm = new Hyperswarm({ keyPair: device_keypair, bootstrap })

  swarm.on('connection', (conn) => {
    console.log('Peer connected')
    if (drive) drive.replicate(conn) // start replication
    
    const mux = get_muxer(conn)
    mux.pair({ protocol: 'blind-pairing' }, () => {})
    
    // Set up pairing channels for invites
    for (const [channel_id, invite_info] of invites.entries()) {
      pairing_channel(mux, Buffer.from(channel_id, 'hex'), invite_info)
    }
    
    // If we are trying to join someone, set up candidate channel (only if not already exists)
    // so we dont create a new channel for every peer that connects.
    if (candidate) {
      const channel_id = candidate.discoveryKey.toString('hex')
      if (!pairing_channels.has(channel_id)) {
        console.log('Attaching candidate channel for discovery key:', channel_id)
        pairing_channel(mux, candidate.discoveryKey, { isCandidate: true })
      }
    }
    
    // Share subscribed drives with the peer
    // so if the author is offline other peers can share data of author if they have it. 
    for (let sub_drive of subscriptions.values()) sub_drive.replicate(conn)
  })
  
  await swarm.join(topic).flushed()
  console.log('Connected to network')
}

// Creating the protomux pairing channel 
function pairing_channel(mux, discoveryKey, info) {
  const channel_id = b4a.toString(discoveryKey, 'hex')
  
  // Create channel with 4 different message types (explained below)
  const ch = mux.createChannel({
    protocol: 'blind-pairing',
    id: discoveryKey, // using discoverykey (form the invite) to make sure only inviter/invitee communicate.
    messages: [
      // message 0: Initial pairing request from candidate to inviter
      { encoding: c.buffer, onmessage: (payload) => handle_pairing_request(payload, channel_id, ch) },
      // message 1: Response from inviter back to candidate (accept/deny)
      { encoding: c.buffer, onmessage: (payload) => candidate?.handleResponse(payload) },
      // message 2: Writer key from candidate to inviter (so candidate can post)
      { encoding: c.buffer, onmessage: handle_writer_key },
      // Message 3: Identity attestation from inviter to candidate (proves identity)
      { encoding: c.buffer, onmessage: handle_attestation }
    ],
    onopen: () => {
      pairing_channels.set(channel_id, ch) // Track this channel for later use (to send writer key)
    },
    onclose: () => {
      pairing_channels.delete(channel_id) // Clean up when done
    }
  })
  
  if (!ch) {
    return
  }
  
  ch.open() // open channel
  
  // Set up protocol: "blind-pairing" pairing , to make sure both sides use the same protocol
  mux.pair({ protocol: 'blind-pairing', id: discoveryKey }, () => 
    pairing_channel(mux, discoveryKey, info))
  
  if (info.isCandidate && candidate) {
    ch.messages[0].send(candidate.encode()) // Send our pairing request as message type 0
  }
}

// Handle incoming pairing requests from devices trying to join our identity
async function handle_pairing_request(payload, channel_id, pairing_channel) {
  if (!drive) return
  
  console.log(`Received pairing request on channel ${channel_id}`)
  
  // Look the public key we stored when creating this invite
  // This key is needed to decrypt and verify the pairing request
  const public_key = invites.get(channel_id)
  if (!public_key) {
    console.log(`No public key found for channel ${channel_id}`)
    return
  }
  
  // Parse the pairing request from the candidate
  const request = MemberRequest.from(payload)
  request.discoveryKey = Buffer.from(channel_id, 'hex')
  
  try {
    // decrypt the request using our private key
    // to make sure the candidate has the correct invite code
    if (request.open(public_key)) {
      console.log('Pairing request opened successfully')
      invites.delete(channel_id) // Remove invite since its used
      
      // create cryptographic proof that we are the legitimate identity owner
      // This attestation links the candidates device to our master identity
      const attestation = await identity_key.attestDevice(request.userData, device_keypair, proof)
      
      if (attestation) {
        // accept the pairing and give them access to our drive
        request.confirm({ key: drive.base.key })
        console.log('Device paired successfully')
        
        // Send the attestation so they can verify our identity
        // This proves we are who we claim to be
        pairing_channel.messages[3].send(attestation)
        console.log('Attestation sent to invitee')
        
        // Send our response confirming the pairing
        if (request.response) {
          pairing_channel.messages[1].send(request.response)
          console.log('Pairing response sent')
        }
        console.log('Waiting for writer key from paired device...')
      } else {
        // Reject the pairing if identity verification fails
        request.deny()
        console.log('Device verification failed')
        if (request.response) pairing_channel.messages[1].send(request.response)
      }
    }
  } catch (e) {
    console.log('Pairing request failed:', e.message)
  }
}

// final step: receive writer key from newly paired device so they can post to our shared drive
async function handle_writer_key(payload) {
  console.log('Received writer key from paired device')
  
  if (drive) {
    try {
      // add the device's writer key to our drive's authorized writers list
      await drive.add_writer(payload)
      console.log('Added new writer successfully')
    } catch (error) {
      console.log('Failed to add writer:', error.message)
    }
  }
}

// Verify identity attestation from the inviter (
async function handle_attestation(payload) {
  // Only verify attestation if we don't have our own identity yet (we're joining)
  if (!identity) {
    console.log('Received attestation, verifying inviter identity...')
    
    try {
      const info = identity_key.verify(payload, null, {
        expectedDevice: device_keypair.publicKey
      })
      
      if (info) {
        console.log('Inviter identity verified successfully!')
        // double-check that the attestation was made for our specific device
        console.log('Identity match:', b4a.equals(info.devicePublicKey, device_keypair.publicKey))
      } else {
        console.log('Inviter identity verification failed')
      }
    } catch (error) {
      console.log('Attestation verification error:', error.message)
    }
  }
}

// Post a message to our drive
async function post_message() {
  const message = await question('Message: ')
  const content = JSON.stringify({
    message,
    timestamp: new Date().toISOString(),
    author: drive.base.key.toString('hex').slice(0, 8)
  })
  
  await drive.put(`/post_${Date.now()}.txt`, Buffer.from(content))
  console.log('Posted!')
}

// Generate invite code for others to join our network
async function create_invite() {
  if (!drive) return console.log('Create identity first')
  
  // create the invite using our drive key 
  const { invite, publicKey } = make_invite(drive.base.key)
  
  // decode the invite to extract the discovery key (used for finding each other on network)
  const decoded = c.decode(require('blind-pairing-core/lib/messages').Invite, invite)
  const channel_id = b4a.toString(decoded.discoveryKey, 'hex')
  
  // store the public key so we can verify pairing requests for this invite
  invites.set(channel_id, publicKey)
  
  // show the base64 encoded invite code to share with others
  console.log(`\nInvite: ${b4a.toString(invite, 'base64')}`)
  console.log(`Channel ID: ${channel_id}`)
  
  // set up pairing channels on all existing connections

  if (swarm) {
    for (const conn of swarm.connections) {
      pairing_channel(get_muxer(conn), decoded.discoveryKey, { isInviter: true })
    }
  }
}

// Subscribe to another user drive to see their posts
async function subscribe() {
  const name = await question('Subscription name: ')
  const key = await question('Drive key: ')
  
  try {
    const sub_drive = create_autodrive(new corestore(ram), Buffer.from(key, 'hex'))
    await sub_drive.ready()
    subscriptions.set(name, sub_drive)
    
    if (swarm) for (const conn of swarm.connections) sub_drive.replicate(conn)
    console.log(`Subscribed to ${name}`)
  } catch (error) {
    console.log('Subscribe failed:', error.message)
  }
}

// Display all posts from our drive and subscribed drives
async function list_posts() {
  console.log('\nPosts:')
  
  const show_posts = async (drive_obj, title = '') => {
    if (title) console.log(`\n${title}:`)
    try {
      const files = await drive_obj.list('/')
      for await (const file of files) {
        if (file.startsWith('/post_')) {
          const content = await drive_obj.get(file)
          const post = JSON.parse(content.toString())
          console.log(`[${post.timestamp}] ${post.author}: ${post.message}`)
        }
      }
    } catch (e) {
      console.log(title ? 'No posts yet' : 'No posts in main drive')
    }
  }
  
  await show_posts(drive)
  for (let [name, sub_drive] of subscriptions) await show_posts(sub_drive, name)
}

// Main menu loop
async function menu() {
  while (true) {
    console.log('\nMenu:')
    console.log('1. Post  2. Invite  3. Subscribe  4. List Posts  5. Info  6. Exit')
    
    const choice = await question('Choice: ')
    
    switch (choice) {
      case '1': await post_message(); break
      case '2': await create_invite(); break
      case '3': await subscribe(); break
      case '4': await list_posts(); break
      case '5': 
        console.log(`Drive: ${drive.base.key.toString('hex')}`)
        console.log(`Device: ${b4a.toString(device_keypair.publicKey, 'hex')}`)
        console.log('Active pairing channels:', pairing_channels.size)
        console.log('Active connections:', swarm?.connections.size || 0)
        for (const [id, ch] of pairing_channels.entries()) {
          console.log(`  Channel ${id}: closed=${ch.closed}, destroyed=${ch.destroyed}`)
        }
        break
      case '6':
        if (swarm) await swarm.destroy()
        rl.close()
        process.exit(0)
      default: console.log('Invalid choice')
    }
  }
}

async function main() {
  console.log('P2P News App')
  console.log('1. Make Identity  2. Join Identity')
  
  const choice = await question('Choice: ')
  
  if (choice === '1') await create_identity()
  else if (choice === '2') await join_identity()
  else {
    console.log('Invalid choice')
    process.exit(1)
  }
  
  await menu()
}

main().catch(console.error)
