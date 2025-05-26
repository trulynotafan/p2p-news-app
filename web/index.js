const b4a = require('b4a')
const Hyperswarm = require('hyperswarm')
const DHT = require('@hyperswarm/dht-relay')
const Stream = require('@hyperswarm/dht-relay/ws')
const HyperWebRTC = require('hyper-webrtc')
const Protomux = require('protomux')
const c = require('compact-encoding')
const Corestore = require('corestore')
const RAM = require('random-access-memory')

const topic = b4a.from('ffb09601562034ee8394ab609322173b641ded168059d256f6a3d959b2dc6021', 'hex')

const store = new Corestore(RAM.reusable())
const core = store.get({ name: 'test-core' })

start()

async function start() {
  const socket = new WebSocket('ws://localhost:8080')
  socket.addEventListener('open', () => {
    console.log('Connected to DHT relay')
    const dht = new DHT(new Stream(true, socket))
    const swarm = new Hyperswarm({ dht })

    const join = () => swarm.join(topic, { server: true, client: true }).flushed()
    join().then(() => console.log('Joined swarm'))
    setInterval(join, 5000)

    swarm.on('connection', (relay, details) => {
      console.log('New peer connected')
      
      if (!relay.userData) relay.userData = null

      const mux = new Protomux(relay)
      let hasReceivedFeedkey = false
      
      const identity_channel = mux.createChannel({
        protocol: 'identity-exchange',
        onopen: () => {
          const protocol_msg = identity_channel.addMessage({
            encoding: c.json,
            onmessage: (message) => {
              try {
                if (message.type === 'protocol') {
                  console.log(`Peer type: ${message.data}`)
                  
                  if (message.data === 'browser') {
                    const stream = HyperWebRTC.from(relay, { initiator: relay.isInitiator })
                    console.log('Upgrading to WebRTC...')

                    stream.on('open', () => {
                      console.log('WebRTC connection established')
                      protocol_msg.send({
                        type: 'feedkey',
                        feedkey: core.key.toString('hex')
                      })
                      store.replicate(stream)
                    })

                    stream.on('close', () => console.log('WebRTC connection closed'))
                    stream.on('error', (err) => console.error('WebRTC error:', err))
                  }
                } else if (message.type === 'feedkey' && !hasReceivedFeedkey) {
                  hasReceivedFeedkey = true
                  
                  let keyBuffer
                  if (typeof message.feedkey === 'string' && message.feedkey.includes(',')) {
                    const numbers = message.feedkey.split(',').map(n => parseInt(n.trim(), 10))
                    keyBuffer = b4a.allocUnsafe(32)
                    for (let i = 0; i < 32; i++) keyBuffer[i] = numbers[i]
                  } else if (typeof message.feedkey === 'string') {
                    keyBuffer = b4a.from(message.feedkey, 'hex')
                  } else if (Array.isArray(message.feedkey)) {
                    keyBuffer = b4a.from(message.feedkey)
                  }
                  
                  if (keyBuffer.length !== 32) {
                    console.error('Invalid key length:', keyBuffer.length)
                    return
                  }
                  
                  const hexKey = Array.from(keyBuffer).map(b => b.toString(16).padStart(2, '0')).join('')
                  console.log('Received peer key:', hexKey.substring(0, 16) + '...')
        
                }
              } catch (err) {
                console.error('Message handling error:', err)
              }
            }
          })

          protocol_msg.send({ 
            type: 'protocol', 
            name: 'browser',
            data: 'browser'
          })
        }
      })

      identity_channel.open()
      relay.on('close', () => console.log('Peer disconnected'))
      relay.on('error', (err) => console.error('Relay error:', err))
    })
  })

  socket.addEventListener('error', console.error)
  socket.addEventListener('close', () => console.log('WebSocket closed'))
}

