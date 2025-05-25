const b4a = require('b4a')
const Hyperswarm = require('hyperswarm')
const DHT = require('@hyperswarm/dht-relay')
const Stream = require('@hyperswarm/dht-relay/ws')
const HyperWebRTC = require('hyper-webrtc')
const Protomux = require('protomux')
const c = require('compact-encoding')

const topic = b4a.from('ffb09601562034ee8394ab609322173b641ded168059d256f6a3d959b2dc6021', 'hex')

start()

async function start() {
  // setup websocket connection to relay
  const socket = new WebSocket('ws://localhost:8080')
  socket.addEventListener('open', () => {
    console.log('Connected to DHT relay')
    const dht = new DHT(new Stream(true, socket))
    const swarm = new Hyperswarm({ dht })

    // join swarm and dont miss any connections (for now)
    const join = () => swarm.join(topic, { server: true, client: true }).flushed()
    join().then(() => console.log('Joined swarm'))
    setInterval(join, 5000)

    // handle new connections
    swarm.on('connection', (relay, details) => {
      console.log('New connection established')
      
      const mux = new Protomux(relay)
      
      // First channel for identity exchange
      const identity_channel = mux.createChannel({
        protocol: 'identity-exchange',
        onopen: () => {
          console.log("Identity channel opened")
          
          const protocol_msg = identity_channel.addMessage({
            encoding: c.json,
            onmessage: (message) => {
              try {
                console.log(`Peer ${message.name} is ${message.data}`)
                
                // If peer is browser, upgrade to WebRTC
                if (message.data === 'browser') {
                  const stream = HyperWebRTC.from(relay, { initiator: relay.isInitiator })
                  console.log('Created WebRTC stream')

                  stream.on('open', () => {
                    console.log('WebRTC stream opened')
                  })

                  stream.on('close', () => {
                    console.log('WebRTC stream closed')
                  })

                  stream.on('error', (err) => {
                    console.error('WebRTC stream error:', err)
                  })
                }
              } catch (err) {
                console.error('Error handling identity message:', err)
              }
            }
          })

          // Send our identity
          console.log("Sending our identity")
          protocol_msg.send({ 
            type: 'protocol', 
            name: 'browser',
            data: 'browser'
          })
        }
      })

      identity_channel.open()

      // handle relay connection events
      relay.on('close', () => {
        console.log('Connection closed')
      })

      relay.on('error', (err) => {
        console.error('Relay error:', err)
      })
    })
  })

  // handle websocket events
  socket.addEventListener('error', console.error)
  socket.addEventListener('close', () => console.log('WebSocket closed'))
}
