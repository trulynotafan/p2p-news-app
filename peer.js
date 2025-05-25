const b4a = require('b4a')
const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const sodium = require('sodium-universal')
const crypto = require("hypercore-crypto")
const process = require("bare-process")
const fs = require('bare-fs').promises
const protomux = require('protomux')
const c = require('compact-encoding')

const topic = b4a.from('ffb09601562034ee8394ab609322173b641ded168059d256f6a3d959b2dc6021', 'hex')

start()

/******************************************************************************
  START
******************************************************************************/
async function start(flag) { 
  const parsed_args = parse(process.argv.slice(2))
  const validated_args = validate(parsed_args)
  const name = validated_args['--name']
  const label = `\x1b[${process.pid % 2 ? 31 : 34}m[peer-${name}]\x1b[0m`
  
  console.log(label, 'start')

  const opts = {
   namespace: 'noisekeys',
   seed: crypto.randomBytes(32),
   name: 'noise'
  }
  const { publicKey, secretKey } = create_noise_keypair(opts)
  console.log(label, { peerkey: publicKey.toString('hex')})
  const key_pair = { publicKey, secretKey }
  const store = new Corestore(`./storage-${name}`)
  const core = store.get({ name: 'test-core' })
  await core.ready()
  console.log(label, `✅ Successfully created a new core with the key`)
  console.log(label, { corekey: core.key.toString('hex') })
  await core.append('Hello, peer!')
  const bootstrap = JSON.parse(await fs.readFile('bootstrap.json', 'utf-8'))
  const swarm = new Hyperswarm({ keyPair: key_pair, bootstrap })
  swarm.on('connection', onconnection)
  console.log(label, 'Joining swarm')
  swarm.join(topic, {server: true, client: true})
  swarm.flush()
  console.log("Swarm Joined, looking for peers")
  let iid = null 

  async function onconnection(socket, info) {
    console.log("New Peer Joined, Their Public Key is: ", info.publicKey.toString('hex'))
    socket.on('error', onerror)

    const mux = new protomux(socket)
    
    const identity_channel = mux.createChannel({
      protocol: 'identity-exchange',
      onopen: () => {
        console.log("Identity channel opened")
        
        const protocol_msg = identity_channel.addMessage({
          encoding: c.json,  
          onmessage: (message) => {
            try {
              console.log(`Peer ${message.name} is ${message.data}`)
              identity_channel.close()
              
              create_feed_channel()
            } catch (err) {
              console.error('Error handling identity message:', err)
            }
          }
        })

        console.log("Sending our identity")
        protocol_msg.send({ 
          type: 'protocol', 
          name: name,  
          data: 'native' 
        })
      }
    })

    identity_channel.open()

    function create_feed_channel() {
      const channel = mux.createChannel({
        protocol: 'feed exchange',
        onopen: () => {
          console.log("Channel opened, setting up message handlers")
          
          const string_msg = channel.addMessage({
            encoding: c.string,
            onmessage: (message) => {
              try {
                const received_key = message.trim()
                console.log("Received core key from peer:", received_key)
                
                const cloned_core = store.get(b4a.from(received_key, 'hex'))
                cloned_core.on('append', onappend)
                cloned_core.ready().then(async () => {
                  console.log("Cloned core ready:", cloned_core.key.toString('hex'))
                  
                  const unavailable = []
                  if (cloned_core.length) {
                    for (var i = 0, L = cloned_core.length; i < L; i++) {
                      const raw = await cloned_core.get(i, { wait: false })
                      if (raw) console.log(label, 'local:', { i, message: raw.toString('utf-8') })
                      else unavailable.push(i)
                    }
                  }

                  for (var i = 0, L = unavailable.sort().length; i < L; i++) {
                    const raw = await cloned_core.get(i)
                    console.log(label, 'download:', { i, message: raw.toString('utf-8') })
                  }
                })
              } catch (err) {
                console.error('Error handling message:', err)
              }
            }
          })

          console.log("Sending our core key to peer")
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
  const noise_seed = derive_seed(namespace, seed, name)
  const public_key = b4a.alloc(32)
  const secret_key = b4a.alloc(64)
  if (noise_seed) sodium.crypto_sign_seed_keypair(public_key, secret_key, noise_seed)
  else sodium.crypto_sign_keypair(public_key, secret_key)
  return { publicKey: public_key, secretKey: secret_key }
}

function derive_seed (primary_key, namespace, name) {
  if (!b4a.isBuffer(namespace)) namespace = b4a.from(namespace) 
  if (!b4a.isBuffer(name)) name = b4a.from(name)
  if (!b4a.isBuffer(primary_key)) primary_key = b4a.from(primary_key)
  const out = b4a.alloc(32)
  sodium.crypto_generichash_batch(out, [namespace, name, primary_key])
  return out
}

function parse (L) {
  const arr = []
  for (var i = 0; i < L.length; i += 2) arr.push([L[i], L[i+1]])
  return Object.fromEntries(arr)
}

function validate (opts) {
  if (!opts['--name']) throw new Error('requires flag: --name <name_string>')
  return opts
}
