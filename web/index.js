const b4a = require('b4a')
const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const DHT = require('@hyperswarm/dht-relay')
const Stream = require('@hyperswarm/dht-relay/ws')
const HyperWebRTC = require('hyper-webrtc')
const protomux = require('protomux')
const c = require('compact-encoding')
const RAM = require('random-access-memory')
const sodium = require('sodium-universal')
const crypto = require("hypercore-crypto")

const topic = b4a.from('ffb09601562034ee8394ab609322173b641ded168059d256f6a3d959b2dc6021', 'hex')

start()

/******************************************************************************
  START
******************************************************************************/
async function start(flag) {
  const label = 'browser'
  console.log(label, 'start')

  const opts = {
    namespace: 'noisekeys',
    seed: crypto.randomBytes(32),
    name: 'noise'
  }
  const { publicKey, secretKey } = create_noise_keypair(opts)
  console.log(label, { peerkey: publicKey.toString('hex')})
  const keyPair = { publicKey, secretKey }

  const store = new Corestore(RAM.reusable())
  const core = store.get({ name: 'test-core' })
  await core.ready()
  console.log(label, `✅ Successfully created a new core with the key`)
  console.log(label, { corekey: core.key.toString('hex') })
  await core.append('Hello, browser!')

  // setup websocket connection to relay
  const socket = new WebSocket('ws://localhost:8080')
  socket.addEventListener('open', () => {
    console.log(label, 'Connected to DHT relay')
    const dht = new DHT(new Stream(true, socket))
    const swarm = new Hyperswarm({ dht, keyPair })
    swarm.on('connection', onconnection)
    console.log(label, 'Joining swarm')
    swarm.join(topic, {server: true, client: true})
    swarm.flush()
    console.log(label, "Swarm Joined, looking for peers")
  })

  // handle websocket events
  socket.addEventListener('error', console.error)
  socket.addEventListener('close', () => console.log(label, 'WebSocket closed'))

  async function onconnection(socket, info) {
    console.log(label, "New Peer Joined, Their Public Key is: ", info.publicKey.toString('hex'))
    socket.on('error', onerror)

    const mux = new protomux(socket)
    
    // First channel for identity exchange
    const identity_channel = mux.createChannel({
      protocol: 'identity-exchange',
      onopen: () => {
        console.log(label, "Identity channel opened")
        
        const protocol_msg = identity_channel.addMessage({
          encoding: c.json,  // Using JSON encoding for structured messages
          onmessage: (message) => {
            try {
              console.log(label, `Peer ${message.name} is ${message.data}`)
              
              // If peer is browser, upgrade to WebRTC
              if (message.data === 'browser') {
                console.log(label, 'Upgrading to WebRTC connection')
                const stream = HyperWebRTC.from(socket, { initiator: socket.isInitiator })
                console.log(label, 'Created WebRTC stream')

                stream.on('open', () => {
                  console.log(label, 'WebRTC stream opened')
                })

                stream.on('close', () => {
                  console.log(label, 'WebRTC stream closed')
                })

                stream.on('error', (err) => {
                  console.error(label, 'WebRTC stream error:', err)
                })
              } else {
                console.log(label, 'Using raw socket connection - not a WebRTC peer')
              }

              // Close identity channel after receiving the message
              identity_channel.close()
              
              // Now create feed exchange channel
              createFeedChannel()
            } catch (err) {
              console.error('Error handling identity message:', err)
            }
          }
        })

        // Send our identity
        console.log(label, "Sending our identity")
        protocol_msg.send({ 
          type: 'protocol', 
          name: 'browser',
          data: 'browser' 
        })
      }
    })

    identity_channel.open()

    // Function to create feed exchange channel after identity exchange
    function createFeedChannel() {
      const channel = mux.createChannel({
        protocol: 'feed exchange',
        onopen: () => {
          console.log(label, "Channel opened, setting up message handlers")
          
          const string_msg = channel.addMessage({
            encoding: c.string,
            onmessage: (message) => {
              try {
                const received_key = message.trim()
                console.log(label, "Received core key from peer:", received_key)
                
                const clonedCore = store.get(b4a.from(received_key, 'hex'))
                clonedCore.on('append', onappend)
                clonedCore.ready().then(async () => {
                  console.log(label, "Cloned core ready:", clonedCore.key.toString('hex'))
                  
                  const unavailable = []
                  if (clonedCore.length) {
                    for (var i = 0, L = clonedCore.length; i < L; i++) {
                      const raw = await clonedCore.get(i, { wait: false })
                      if (raw) console.log(label, 'local:', { i, message: raw.toString('utf-8') })
                      else unavailable.push(i)
                    }
                  }

                  for (var i = 0, L = unavailable.sort().length; i < L; i++) {
                    const raw = await clonedCore.get(i)
                    console.log(label, 'download:', { i, message: raw.toString('utf-8') })
                  }
                })
              } catch (err) {
                console.error('Error handling message:', err)
              }
            }
          })

          console.log(label, "Sending our core key to peer")
          string_msg.send(core.key.toString('hex'))
        }
      })

      channel.open()
      store.replicate(socket)
      iid = setInterval(append_more, 1000)
    }
  }

  function onerror(err) {
    clearInterval(iid)
    console.log(label, 'socket error', err)
  }

  function append_more() {
    const time = Math.floor(process.uptime())
    const stamp = `${time/60/60|0}h:${time/60|0}m:${time%60}s`
    core.append(`uptime: ${stamp}`)
  }

  async function onappend() {
    const L = core.length
    if (!flag) {
      flag = true
      for (var i = 0; i < L; i++) {
        const raw = await core.get(i)
        console.log(label, 'download old:', { i, message: raw.toString('utf-8') })
      }
    }
    console.log(label, "notification: 📥 New data available", L)
    const raw = await core.get(L)
    console.log(label, { i: L, message: raw.toString('utf-8') })
  }
}

/******************************************************************************
  HELPER
******************************************************************************/

function create_noise_keypair ({ namespace, seed, name }) {
  const noiseSeed = derive_seed(namespace, seed, name)
  const publicKey = b4a.alloc(32)
  const secretKey = b4a.alloc(64)
  if (noiseSeed) sodium.crypto_sign_seed_keypair(publicKey, secretKey, noiseSeed)
  else sodium.crypto_sign_keypair(publicKey, secretKey)
  return { publicKey, secretKey }
}

function derive_seed (primaryKey, namespace, name) {
  if (!b4a.isBuffer(namespace)) namespace = b4a.from(namespace) 
  if (!b4a.isBuffer(name)) name = b4a.from(name)
  if (!b4a.isBuffer(primaryKey)) primaryKey = b4a.from(primaryKey)
  const out = b4a.alloc(32)
  sodium.crypto_generichash_batch(out, [namespace, name, primaryKey])
  return out
}
