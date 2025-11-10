const b4a = require('b4a')
const Hyperswarm = require('hyperswarm')
const DHT = require('@hyperswarm/dht-relay')
const Stream = require('@hyperswarm/dht-relay/ws')
const HyperWebRTC = require('hyper-webrtc')
const Protomux = require('protomux')
const Corestore = require('corestore')
const RAW = require('random-access-web')
const { create_mnemonic_keypair, save, load } = require('../../../src/node_modules/helpers/crypto-helpers')
const { identity_exchange_protocol } = require('../../../src/node_modules/helpers/protocol-helpers')
const blog_helper = require('../blog-helpers-v2')

const topic = b4a.from('ffb09601562034ee8394ab609322173b641ded168059d256f6a3d959b2dc6021', 'hex')
const PEERS_STORAGE_KEY = 'discovered_peers'

async function start_browser_peer (options = {}) {
  const name = options.name || 'browser-peer'
  const invite_code = options.invite_code // For joining existing networks
  const is_dev = location.hostname === 'localhost' || location.hostname.startsWith('192.') || location.hostname.startsWith('10.')
  const relay_url = options.relay || (is_dev ? 'ws://localhost:8080' : 'wss://relay-production-9c0e.up.railway.app')
  const get_blog_key = options.get_blog_key
  const get_blog_autobase = options.get_blog_autobase

  const store = new Corestore(RAW(`blogs-${name}`))

  // load saved peer
  let saved_peers = {}
  try {
    const saved = localStorage.getItem(PEERS_STORAGE_KEY)
    if (saved) saved_peers = JSON.parse(saved)
  } catch (err) {
    console.error('Error loading saved peers:', err)
  }

  await store.ready()

  return new Promise((resolve, reject) => {
    const socket = new WebSocket(relay_url)

    function handle_socket_error (err) {
      // If invalid URL, reject. If valid URL but down, go offline mode
      const errorMessage = err.message || err.toString() || ''
      if (errorMessage.includes('Invalid URL') || errorMessage.includes('URL scheme') || errorMessage.includes('ERR_INVALID_URL')) {
        reject(new Error(`Invalid relay URL: ${relay_url}`))
      } else {
        resolve({ store, swarm: null, dht: null, cleanup: () => {} })
      }
    }

    socket.addEventListener('error', handle_socket_error)
    socket.addEventListener('close', () => {})

    async function handle_socket_open () {
      try {
        // Verify socket is ready
        if (socket.readyState !== WebSocket.OPEN) {
          console.error('Socket not ready:', socket.readyState)
          return
        }

        // key management
        const seedphrase = await load(name)
        const mnemonic_data = seedphrase
          ? await create_mnemonic_keypair({ namespace: 'noisekeys', name: 'noise', mnemonic: seedphrase })
          : await create_mnemonic_keypair({ namespace: 'noisekeys', name: 'noise' })

        if (!seedphrase) await save(mnemonic_data.mnemonic, name)

        // Create DHT stream
        const stream = new Stream(true, socket)
        const dht = new DHT(stream)
        const swarm = new Hyperswarm({ dht, key_pair: mnemonic_data.keypair })

        // Set up connection handler BEFORE joining
        function handle_swarm_connection (relay, details) {
          if (!relay.userData) relay.userData = null
          const mux = new Protomux(relay)

          // protocol handlers
          async function handle_protocol_message (message, send, current_peer_mode) {
            // Store discovered relay for potential future connections
            if (message.data.relay_url) {
              if (!window.discovered_relays) window.discovered_relays = new Set()
              window.discovered_relays.add(message.data.relay_url)
            }

            if (message.data.mode === 'browser' && current_peer_mode === 'browser') {
              const stream = HyperWebRTC.from(relay, { initiator: relay.isInitiator }) // Upgrade to WebRTC

              stream.on('open', () => {
                console.log('WebRTC connection established')
                const blog_key = get_blog_key ? get_blog_key() : null
                if (blog_key) send({ type: 'feedkey', data: blog_key })

                // Replicate all available stores
                store.replicate(stream)
              })

              stream.on('error', (err) => {
                if (!err || (!err.message?.includes('Abort') && !err.message?.includes('closed'))) {
                  console.warn('WebRTC error details:', {
                    message: err?.message,
                    code: err?.code,
                    stack: err?.stack,
                    fullError: err
                  })
                }
              })
            } else if (message.data.mode === 'native') {
              const blog_key = get_blog_key ? get_blog_key() : null
              if (blog_key) send({ type: 'feedkey', data: blog_key })

              // It's a lot easier to just replicate the whole stream instead of replicating individual hypercores. 
              // Currently we are replicating everything but in the future if we want to replicate a specific data structure 
              // we will obviously implement that so this is a to-do.
              store.replicate(relay)
            }
          }

          async function handle_feedkey_message ({ key_buffer }) {
            const hex_key = b4a.toString(key_buffer, 'hex')
            store.emit('peer-autobase-key', { key: hex_key, key_buffer })
          }

          const handlers = {
            on_protocol: handle_protocol_message,
            on_feedkey: handle_feedkey_message
          }

          // protocol setup
          function handle_protocol_init (send) {
            send({
              type: 'protocol',
              data: {
                name,
                mode: 'browser',
                device_public_key: b4a.toString(mnemonic_data.keypair.publicKey, 'hex'),
                relay_url: relay_url
              }
            })
          }

          const setup_protocol = identity_exchange_protocol(handlers, handle_protocol_init, {
            peer_mode: 'browser',
            label: '[browser-peer]'
          })

          const identity_channel = setup_protocol(mux)
          identity_channel.open()

          store.on('peer-add', (peer) => {
            store.emit('peer-autobase-key', {
              key: b4a.toString(get_blog_autobase().key, 'hex'),
              key_buffer: get_blog_autobase().key
            })
          })

          relay.on('error', (err) => {
            if (!err.message?.includes('Duplicate connection')) {
              console.warn('Relay error:', err.message)
            }
          })
        }

        swarm.on('connection', handle_swarm_connection)

        // Now join the swarm AFTER setting up the connection handler
        console.log('Joining swarm')
        const discovery = swarm.join(topic, { server: true, client: true })

        const join_interval = setInterval(() => {
          swarm.join(topic, { server: true, client: true })
            .flushed()
            .catch((err) => console.warn('Join warning:', err.message))
        }, 5000)

        // Attach swarm to store for easy access in blog-helpers
        store.swarm = swarm

        // Handle pairing if invite_code is provided (joining existing blog)
        if (invite_code) {
          await handle_join_with_invite({ invite_code, swarm, store, username: name })
        }

        resolve({ 
          store, 
          swarm, 
          dht, 
          cleanup: () => clearInterval(join_interval)
        })

        // Flush in background, don't block UI
        discovery.flushed()
          .then(() => console.log('Swarm joined'))
          .catch((err) => console.warn('Flush warning:', err.message))
      } catch (error) {
        console.error('Error in socket open handler:', error)
        reject(error)
      }
    }

    socket.addEventListener('open', handle_socket_open)
  })
}

// Handle joining with invite code - SIMPLIFIED with unfied datastructure API
async function handle_join_with_invite (options) {
  const { invite_code, swarm, store, username } = options
  try {
    // Initialize blog with shared keys (blog-helpers handles the rest)
    await blog_helper.init_blog({
      store_instance: store,
      username,
      invite_code,  // Pass invite_code - blog-helpers will use unified datastructure API
      swarm
    })
  } catch (err) {
    console.error('Pairing error:', err)
  }
}

module.exports = { start: start_browser_peer }