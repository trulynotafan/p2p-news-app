const b4a = require('b4a')
const crypto = require('bare-crypto')
const Hyperswarm = require('hyperswarm')
const Protomux = require('protomux')
const Corestore = require('corestore')
const RAM = require('random-access-memory')
const c = require('compact-encoding')
const process = require('bare-process')

// setup constants and store
const topic = b4a.from('ffb09601562034ee8394ab609322173b641ded168059d256f6a3d959b2dc6021', 'hex')
const store = new Corestore(RAM.reusable())
const feeds = new Map()

start()

async function start() {
  // get peer name from command line args
  const args = process.argv.slice(2)
  const name_index = args.indexOf('--name')
  const peer_name = 'native-' + (name_index !== -1 ? args[name_index + 1] : 'anonymous')

  // initialize core and append test data
  await store.ready()
  const name = b4a.toString(crypto.randomBytes(32))
  const core = store.get({ name })
  await core.ready()
  await core.append('Hello from native core!')

  console.log('Core key:', core.key.toString('hex'))
  console.log('Core discovery key:', core.discoveryKey.toString('hex'))
  console.log(`Joined swarm as ${peer_name}, listening for peers...`)

  // create swarm and join topic
  const swarm = new Hyperswarm()
  const join = () => swarm.join(topic, { server: true, client: true }).flushed()
  join().then(() => console.log('Joined swarm'))
  setInterval(join, 5000)

  // handle new connections
  swarm.on('connection', (relay, details) => {
    console.log('New connection established')
    let remote_type = null
    let local_type = 'native'
    let type_resolved = false
    let remote_name = 'unknown'

    // send our name first
    relay.write(peer_name + '\n')

    // get remote name
    relay.once('data', (data) => {
      remote_name = b4a.toString(data).trim()
      console.log(`${remote_name} joined`)

      // setup protomux for protocol messages
      const mux = new Protomux(relay)
      
      // create protocol channel for peer type exchange
      const protocol_channel = mux.createChannel({ protocol: 'protocol' })
      const protocol_msg = protocol_channel.addMessage({
        encoding: c.json,
        onmessage: (msg) => {
          if (type_resolved) return
          if (!msg || !msg.type || !msg.data) return

          console.log('Received protocol message:', msg)
          
          // handle protocol message
          if (msg.type === 'protocol' && msg.data === 'webrtc') {
            remote_type = 'browser'
            type_resolved = true
            console.log(`Peer type resolved: local=${local_type}, remote=${remote_type}`)

            // setup feed channel for data exchange
            const mux = new Protomux(relay)
            const channel = mux.createChannel({ protocol: 'feed-exchange' })
            const feed_msg = channel.addMessage({
              encoding: c.json,
              onmessage: async (msg) => {
                // handle feed key exchange
                if (msg.type === 'feedkey') {
                  const feed_key = b4a.from(msg.feedkey, 'hex')
                  console.log(`Received feed key from ${remote_type}:`, feed_key.toString('hex'))
                  
                  // setup feed replication
                  const feed = store.get(feed_key)
                  await feed.ready()
                  feed.replicate(relay)
                  feeds.set(remote_type, feed)
                  
                  // log new blocks
                  feed.createReadStream({ live: true }).on('data', d => {
                    console.log(`[${remote_type}] New block:`, d.toString())
                  })
                }
              }
            })
            
            // start feed exchange
            channel.open()
            console.log('Sending feed key:', core.key.toString('hex'))
            feed_msg.send({ type: 'feedkey', feedkey: core.key.toString('hex') })
            core.replicate(relay)
          } else {
            console.log('Using raw socket connection - not a WebRTC peer')
          }
        }
      })

      // send initial protocol message
      protocol_channel.open()
      console.log('Sending protocol message:', { type: 'protocol', data: 'native' })
      protocol_msg.send({ type: 'protocol', data: 'native' })

      // handle relay connection events
      relay.on('close', () => {
        console.log('Connection closed')
      })

      relay.on('error', (err) => {
        console.error('Relay error:', err)
      })
    })
  })
} 
