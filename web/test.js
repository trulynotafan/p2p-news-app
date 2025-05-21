const b4a = require('b4a')
const crypto = require('crypto')
const Hyperswarm = require('hyperswarm')
const DHT = require('@hyperswarm/dht-relay')
const Stream = require('@hyperswarm/dht-relay/ws')
const HyperWebRTC = require('hyper-webrtc')
const Protomux = require('protomux')
const c = require('compact-encoding')
const Corestore = require('corestore')
const RAM = require('random-access-memory')

const topic_hex = 'ffb09601562034ee8394ab609322173b641ded168059d256f6a3d959b2dc6021'
const topic = b4a.from(topic_hex, 'hex')
const peer_name = 'browser'

const store = new Corestore(RAM.reusable())

start()

async function start () {
  await store.ready()
  const name = b4a.toString(crypto.randomBytes(32))
  console.log('Creating core with name:', name)
  const core = store.get({ name })
  await core.ready()

  await core.append('Hello from Corestore in the browser!')
  const value = await core.get(0)
  console.log('Core value:', value.toString())
  console.log('Core key:', core.key.toString('hex'))
  console.log('Core discovery key:', core.discoveryKey.toString('hex'))

  const socket = new WebSocket('ws://localhost:8080')

  socket.addEventListener('open', async () => {
    console.log('Connected to DHT relay')

    const dht = new DHT(new Stream(true, socket))
    const swarm = new Hyperswarm({ dht })

    const discovery = swarm.join(topic, { server: true, client: true })
    await discovery.flushed()
    console.log(`Joined swarm as ${peer_name}`)

    setInterval(() => {
      swarm.join(topic, { server: true, client: true }).flushed().then(() => {
        console.log('Refreshed discovery')
      })
    }, 5000)

    swarm.on('connection', (conn, info) => {
      conn.write(peer_name + '\n')

      let remote_name = 'unknown'

      conn.once('data', (data) => {
        remote_name = b4a.toString(data).trim()
        console.log(`${remote_name} joined`)

        const upgradeToProtomux = (stream, label) => {
          const mux = new Protomux(stream)

          // Chat channel 
          const chat = mux.createChannel({
            protocol: 'chat-message',
            onopen () {
              console.log(`Chat protocol opened with ${label}`)
            },
            onclose () {
              console.log(`Chat protocol closed with ${label}`)
            }
          })

          const chatMsg = chat.addMessage({
            encoding: c.string,
            onmessage (m) {
              console.log(`Received chat from ${label}:`, m)
            }
          })

          chat.open()
          setTimeout(() => {
            chatMsg.send(`Hello from ${peer_name} via Protomux`)
          }, 1000)

          // Feed key exchange channel
          const feedChannel = mux.createChannel({
            protocol: 'feed-key',
            onopen () {
              console.log(`Feed channel opened with ${label}`)
              // Send our feed key

              setTimeout(() => {
                feedMsg.send(core.key)
                console.log(`Sent feed key to ${label}:`, core.key.toString('hex'))
              }, 500)
              
              
            },
            onclose () {
              console.log(`Feed channel closed with ${label}`)
            }
          })

          const feedMsg = feedChannel.addMessage({
            encoding: c.buffer, 
            onmessage (feedKey) {
              console.log(`Received feed key from ${label}:`, feedKey.toString('hex'))

              const remoteCore = store.get({ key: feedKey })
              remoteCore.ready().then(() => {
                console.log(`Started replicating remote core: ${feedKey.toString('hex')}`)
                remoteCore.createReadStream({ live: true }).on('data', (data) => {
                  console.log(`Data from ${label}'s core:`, data.toString())
                })
              })
            }
          })

          feedChannel.open()
        }

        if (!remote_name.startsWith('native-')) {
          console.log('Upgrading connection to WebRTC...')
          const rtc = HyperWebRTC.from(conn)

          rtc.on('open', () => {
            console.log('WebRTC stream established with', remote_name)
            upgradeToProtomux(rtc, remote_name)
          })

          rtc.on('error', (err) => {
            console.log('WebRTC error:', err.message)
          })

          rtc.on('close', () => {
            console.log('WebRTC connection closed with', remote_name)
          })
        } else {
          console.log('Native peer detected, using Protomux over socket.')
          upgradeToProtomux(conn, remote_name)
        }
      })

      conn.on('close', () => {
        console.log(`${remote_name} disconnected`)
      })

      conn.on('error', (err) => {
        console.log('Socket error:', err.message)
      })
    })
  })
}
