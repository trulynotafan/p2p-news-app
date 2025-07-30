# Autodrive Identity System

## Overview

This doc outlines the identity and multi-writer setup for our P2P news app using Autodrive (Autobase + Hyperdrive). It enables secure collaboration across devices, allowing multiple trusted writers to share a data store with cryptographic access control. The identity system balances security, usability, and browser compatibility.

## Core Architecture

### Autodrive Implementation

Our custom [Autodrive](https://github.com/trulynotafan/p2p-news-app/tree/main/src/node_modules/autodrive) implementation uses:
- **[Autobase](https://github.com/holepunchto/autobase/)**: Multi-writer append-only log for coordination
- **[Hyperdrive](https://github.com/holepunchto/hyperdrive)**: File system interface for content storage
- **[Keet Identity Key](https://github.com/holepunchto/keet-identity-key)**: Cryptographic identity management for device authentication

If you want to learn more about our stack, see [stack_docs]()

Key features of Autodrive:
```javascript
// creating drive
const store = new Corestore(`./some_storage`)
const drive = await create_drive(store)
await drive.ready
const key = drive.base.key // <== this is how we can share our key for others to join

// joining drive
const drive = await create_drive(store, key) // <== this key could be of the drive we want to join

// adding/removing writers

drive.add_writer(key) // <== this the local key aka the writer key of the person whom we want to add as writer 
drive.remove_writer(key) // to remove some writers.

```
For all APIs and docs of autodrive check out [Autodrive]()



### Identity & Pairing Flow

#### 1. Bootstrap Device (First Device)
- First device would first create the main identity. (By just clicking join)
- The main device will be shown a 12-24 word seedphrase (which the would save for restoration of identity).
- The mnemonic itself will be deleted. Because we shall only be needing the 
- It would be something like this:
```javascript
const identitykey = require('keet-identity-key)
const mnemonic = identitykey.generateMnemonic()

alert("This is you menemonic, Please save it! " + mnemonic)

```

- Now we will create an identity keypair (a determinstic keypair that we will use later for creating proofs and attestation) from the mnemonic (luckily keet-identity-key provides us all of apis)
```javascript
const id = identitykey.from({mnemonic})

console.log(id)
// {
//   keychain: { ... },
//   identityKeyPair: { publicKey: ..., secretKey: ... },
//   discoveryKeyPair: { ... }
// }



```
- Now we will also create a random crypto keypair (this will be the device keypair)
```javascript
const maindevice = crypto.keyPair()

// this keypair is what we will bootstrap with the identity keypair

```
- Now we will bootstrap the device keypair with the idenity keypair
```javascript
const proof0 = await id.bootstrap(maindevice.publicKey)
```
- This proof means ideneitykeypair belongs to the device publickey. (we can now use the proof for attestation)
- So Now we have all the stuff we need for identity verification i.e
- maindevice keypair `maindevice`
- identity keypair publickey `id.identityKeyPair.publicKey `
- proof for attestaion `proof`
- REMEMBER: The mnemonic is not stored anywhere. That means no one can derive the same identity UNLESS user saved it when we showed it.

#### 2. Auxiliary Device (The devices who want to pair with us)

- In general pairing means:
- Our 2nd device has the same identity as our main device
- Our main device knows whom it attested and if it was actually our device
- The device writes into our autodrive (Meaning our book, to learn more about autobase/autodrive/corestore please check our code examples)
- Others preceive us as one logical identity (so if they see our data, they dont differ between devices and trust both)

**Now how does pairing and attestation happens? Lets see below:**

To initiate pairing, the second device must have the following things:

## Invite structure

1. The autodrive key of the main device. i.e `drive.base.key` so it could join the drive.
2. The [secretstream](https://github.com/holepunchto/hyperswarm-secret-stream) public of the main device.
We can do pass our device keypair publickey for secret stream.
This public key will help the 2nd device find our main device among all of the other people in the swarm and establish and encrypted connection with it.
This is so that when we exchange data, no one else sees it.
Heres how secretstream will be created:
```javascript
const stream = new SecretStream(false, null, {
  keyPair: maindevice // the secret stream has option to create stream from our keypairs
})

console.log(maindevice.publicKey.toString('hex') // now this will be used by 2nd device to join our secretstream

```
3. The identity public key of the device.. That will be use for verification of the attestation. (explained above)
4. Some kind of challenge so others dont make invite by their own. And we have extra security. e.g `crypto.randombytes(32)` like a nonce.


Now we will encode all this stuff into a `base64` hex string so 2nd can copy-paste it. 
We will be using compact encoding for it. We can probably use a qrcode. using a popular module called `qrcode` for better UX.

## Connecting 


Great so now that we know what we need here's how it will go.

- There will be an option to create an invite from the main device. It will have the stuff discussed above.
- 2nd device will get this invite either through manual sharing or qrcode url. and decode the invite. 

2nd device will then extract the drivekey to join
```javascript

const drive = createdrive(store, keyitgetsfromtheinvite)

```

- Now, the 2nd device will take the secretstream public key from the main invite and will join it.
```javascript
const stream = new SecretStream(true, null, {
  remotePublicKey: maindevice.publicKey  // This is the "secret" - only Device 2 knows this
})

stream.on('connect', () => {
  console.log('Device 2: Successfully joined the stream!')
  console.log('Connected to device with public key:', stream.remotePublicKey.toString('hex'))

// now that its joined, we can send or receive data!


// we can write via
stream.write('hey this is some data')

// we can receive via
stream.on('data', (data) => {
  console.log('Device 2 received:', data.toString())
})

```

Great! We can now privately communicate.. Let's begin the attestation shall we?


## Attestation

- First the 2nd device will send:
- Its public key, created via `crypto.keyPair()` as discussed above.
When our main device receives it, we shall begin the attestation:

Note: This will happen on main device.

```javascript

/* we will take three things:

1. Proof (we created earlier)
2. maindevice keypair (we created earlier)
3. The 2nd device's  publickey. which it sent.
*/

const publickey = device2.publickey // what we receive
const keypair = maindevice.keyPair

  const attestation = await identitykey.attestDevice(publicKey, keypair, proof)
  
  if (attestation === null) {
    throw new Error('attestation failed')
  }
else
stream.write("this is the attestation", attestation)


  // Now verify the attestation using IdentityKey.verify (this can be used by aux devices to know they have been attested)
  const info = identitykey.verify(attestation, null, {
    expectedIdentity: identity,
    expectedDevice: device2.publicKey
  })

  if (info === null) {
    throw new Error('verify failed')
  } else {
    console.log('Verification results:', [
      b4a.equals(info.identityPublicKey, id.identityKeyPair.publicKey),
      b4a.equals(info.devicePublicKey, device2.publicKey),
    ]) // [true, true]
  }



```

## Additon as writer

When the 2nd device verifes the attestation, it will send it's writer key (explained below) to be added as writer.

Now writerkey is the key that is required by the author of the autodrive to add people as writers.
in general you can see you writerkey after creating autodrive, like this `const mywriterkey = drive.base.local.key`

After the main device receives it, it will add the 2nd device as writer to our autodrive :)
like this:

```javascript
drive.add_writer(writerkey_of_2nd_device)

```

And that's it, both peers can now close the secret stream, write to the same autodrive, replicate as normal, and other peers can subscribe to one of them and will see all the posts no matter which device posts.


### Data Organization

The data organization is simple, we have our own drive in which we post.
And for peers we discover, we create peer drive and download their data. e.g

```javascript
const peer_drive = create_autodrive(store, b4a.from(init_block.drive_key, 'hex'))


```
The `init_block` contains all the drive_key. If you want to see more on how we manage subscription check out [blog_helpers]()




### Subscription 
- Devices can subscribe to external (non-paired) peers
- Subscription state managed in localStorage for persistence
```javascript 
function set_subscription_store (s) { subscription_store = s }

// Local storage for keeping track of subscribed peers
function get_local_subscribed_peers () {
  if (subscription_store) return subscription_store.get()
  try { return JSON.parse(localStorage.getItem('subscribed_peers') || '[]') } catch { return [] }
}
function add_local_subscribed_peer (key) {
  if (subscription_store) return subscription_store.add(key)
  const arr = get_local_subscribed_peers()
  if (!arr.includes(key)) {
    arr.push(key)
    localStorage.setItem('subscribed_peers', JSON.stringify(arr))
  }
}

```


### Access Control
- **Writers**: Can modify shared drive content
They are added specifically after paring.
```javascript
drive.add_writer(writerkey_of_the_device_to_be_added)
```
- **Subscribers**: External peers with read-only access to public posts
These peers only read/download our blogs.

```javascript

// a snippet of our blog heloer subscibe function
async function subscribe (key) {
  if (already_subscribed(key)) return true

  try {
    const core = get_core(key)
    await core.ready()
    core.on('append', emit_update)

    if (core.length === 0) await core.update({ wait: true })
    if (core.length === 0) throw new Error('empty')

    core.download({ start: 0, end: -1 })

    const init = parse_init(await core.get(0))
    if (init.type !== 'blog-init') throw new Error('invalid')

    const drive = create_drive(init.drive_key)
    drive.ready().then(() => drive.download())

    track_drive(key, drive)
    mark_subscribed(key)
    emit_update()
    return true
  } catch {
    return false
  }
}

```


## Prior Art & References

### Autobase Resources
- [A simple but great explanation of autobase](https://hackmd.io/@serapath/rkKXTd1mxe)
- [Autobase Design Document](https://github.com/holepunchto/autobase/blob/main/DESIGN.md)
- [Autobase GitHub Repository](https://github.com/holepunchto/autobase)
- [Easybase](https://github.com/Drache93/easybase/blob/main/package.json)
- [Autopass](https://github.com/holepunchto/autopass)
- [Autobase Chat](https://github.com/storytellerjr/autobase-chat)
  


### Existing Autodrive Implementations
1. **OzymandiasTheGreat/autodrive**: [GitHub](https://github.com/OzymandiasTheGreat/autodrive)
   - Permissionless but secure multi-writer filesystem
   - Good reference for access control patterns

2. **lejeunerenard/autodrive**: [GitHub](https://github.com/lejeunerenard/autodrive/branches)
   - Working implementation with basic write operations
   - Missing some hyperdrive compatibility methods

3. **Drache93/easybase**: [GitHub](https://github.com/Drache93/easybase)
   - Experimental autobase wrapper
   - Simplified P2P patterns

PS. I would highly recommend easybase for any person who wants to build node/bare P2P applications.

### Technical Dependencies
- [`autobase`](https://github.com/holepunchto/autobase/): Multi-writer coordination
- [`hyperdrive`](https://github.com/holepunchto/hyperdrive): File system interface
- [`keet-identity-key`](https://github.com/holepunchto/keet-identity-key): Cryptographic identity
- [`compact-encoding`](https://github.com/holepunchto/compact-encoding): Message serialization
- [`hyperswarm`](https://github.com/holepunchto/hyperswarm): P2P networking
- [`@hyperswarm-secretstream`](https://github.com/holepunchto/hyperswarm-secret-stream): Encrypted communication with peers.

To understand more about our stack, check out [stack_docs]()


