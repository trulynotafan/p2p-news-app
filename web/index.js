const b4a = require('b4a')
const Hyperswarm = require('hyperswarm')
const DHT = require('@hyperswarm/dht-relay')
const Stream = require('@hyperswarm/dht-relay/ws')

const topic_hex = 'ffb09601562034ee8394ab609322173b641ded168059d256f6a3d959b2dc6021'
const topic = b4a.from(topic_hex, 'hex')
const peer_name = 'browser'

start()

async function start() {
  const socket = new WebSocket('ws://localhost:8080')

  socket.addEventListener('open', async () => {
  console.log('Connected to DHT relay')

  const dht = new DHT(new Stream(true, socket))
  const swarm = new Hyperswarm({ dht })

  const discovery = swarm.join(topic, { server: true, client: true })
  await discovery.flushed()

  console.log(`Joined swarm as ${peer_name}`)

  swarm.on('connection', (conn, info) => {
  conn.write(peer_name + '\n')

  let remote_name = 'unknown'

  conn.once('data', (data) => {
  remote_name = b4a.toString(data).trim()
  console.log(`${remote_name} joined`)
      })

  console.log(`Connected to a new peer`)

  conn.on('close', () => {
        console.log(`${remote_name} disconnected`)
      })

  conn.on('error', (err) => {
     console.log('Socket error:', err.message)
      })
    })
  })
}
