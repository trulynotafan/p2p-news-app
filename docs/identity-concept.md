# Autodrive Identity System

## Overview

This doc outlines the identity and multi-writer architecture for our P2P news application built on Autodrive (an Autobase + Hyperdrive implementation). The system enables secure multi-writer collaboration where multiple devices can write to the same shared data store while maintaining cryptogrphic security and preventing unauthorized access.
This identity system is best for secure, multi-writer P2P applications while maintaining usability and browser compatibility. 

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
const key = drive.base.key / <== this is how we can share our key for others to join

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

1. The autodrive key of the main device. i.e `drive.base.key` so it could join the drive.
2. The  public key of the main device. 











#### 2. Invite System
```javascript
// Invite structure
{
  driveBootstrapKey: "hex_drive_key",    // Shared drive identifier
  bootstrapDeviceKey: "hex_device_key",  // Bootstrap device's public key
  challenge: "timestamp_challenge"       // One-time challenge for security
}
```

#### 3. Pairing Process
1. **Bootstrap device** creates invite with `create_wildcard_Invite()`
2. **New device** receives invite code
3. **New device** joins same drive using `drive-bootstrap_key`
4. **Cryptographic handshake** occurs:
   - New device generates proof using `IdentityKey.bootstrap()`
   - Bootstrap device verifies proof with `verify_challenge()`
   - If valid, new device is added as writer via `pair_with_proof()`

#### 4. Writer Management
- Each device gets writer permissions through cryptographic proof
- Writers tracked in autobase log: `{ type: 'addWriter', key: 'device_key' }`
- Only existing writers can add new writers
- Permissions are replicated across all devices

## Multi-Writer Coordination

### Data Organization
```
/posts/myblogs/posts/    // Own posts from any paired device
/posts/news/posts/       // Subscribed external peers' posts
```

### No conflicts
- Autobase handles ordering of multiple writes
- Last-writer-wins for same path conflicts
- File timestamps provide creation order

### Subscription 
- Devices can subscribe to external (non-paired) peers
- External posts stored in `/posts/news/` to separate from own content
- Subscription state managed in localStorage for persistence

## Security Model

### Device Authentication
- Each device has unique keypair via Keet Identity
- Device public keys used for writer authorization
- Mnemonic-based proof system prevents unauthorized access

### Data Integrity
- All writes signed by device keys
- Drive content cryptographically verified

### Access Control
- **Writers**: Can modify shared drive content
- **Subscribers**: External peers with read-only access to public posts

## Prior Art & References

### Autobase Resources
- [Autobase Design Document](https://github.com/holepunchto/autobase/blob/main/DESIGN.md)
- [Autobase GitHub Repository](https://github.com/holepunchto/autobase)
- [Easybase](https://github.com/Drache93/easybase/blob/main/package.json)


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
- `autobase`: Multi-writer coordination
- `hyperdrive`: File system interface
- `keet-identity-key`: Cryptographic identity
- `compact-encoding`: Message serialization
- `hyperswarm`: P2P networking

## Implementation Details

### Key Exchange Protocol
1. **Discovery**: Peers discover each other via hyperswarm
2. **Drive Key Exchange**: Peers announce their drive keys
3. **Pairing Handshake**: Cryptographic proof exchange for writer access
4. **Subscription**: Non-paired peers can subscribe for read access

## Future Considerations

### Multi-Identity Support
- Support for multiple identities per device
- Identity switching for different rooms

### Advanced Access Control
- Fine grained read/write permissions with voting or revoking.
- Multiple autodrives per identity


## Usage Example

```javascript
// Create bootstrap device
const drive = await create_autodrive(store)
await drive.ready()

// Create invite for new device
const invite = await create_wildcard_invite(mnemonic, drive.base.key, device_key)

// New device joins
const pairDrive = await create_autodrive(store, drive_key)
await pairDrive.ready()

// Cryptographic pairing
const proof = await verify_challenge(challenge, new_device_key)
await drive.pairWithProof(proof, new_device_key)

// Now both devices can write
await drive.put('/posts/myblogs/posts/hello.txt', 'Hello from device 1')
await pairDrive.put('/posts/myblogs/posts/world.txt', 'Hello from device 2')
```

This identity system is best for secure, multi-writer P2P applications while maintaining usability and browser compatibility. 
