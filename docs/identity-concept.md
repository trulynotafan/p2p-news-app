# Autodrive Identity System

## Overview

This doc outlines the identity and multi-writer architecture for our P2P news application built on Autodrive (an Autobase + Hyperdrive implementation). The system enables secure multi-writer collaboration where multiple devices can write to the same shared data store while maintaining cryptogrphic security and preventing unauthorized access.

## Core Architecture

### Autodrive Implementation

Our custom Autodrive implementation (`/src/autodrive/index.js`) uses:
- **Autobase**: Multi-writer append-only log for coordination
- **Hyperdrive**: File system interface for content storage
- **Keet Identity Key**: Cryptographic identity management for device authentication

Key features:
```javascript
// Core API surface
{
  put(path, content),     // Write data
  get(path),              // Read data
  list(folder),           // List directory
  download(folder),       // Download/sync data
  addWriter(key),         // Add writer permissions
  removeWriter(key),      // Remove writer permissions
  pairWithProof(proof, deviceKey), // Add device via cryptographic proof
  replicate(stream)       // P2P replication
}
```

### Identity & Pairing Flow

#### 1. Bootstrap Device (First Device)
- Creates new Autodrive with unique drive key
- Generates mnemonic for identity management
- Can create invite codes for other devices to join

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
- Identity switching for different contexts/groups
- Cross-identity data sharing policies

### Advanced Access Control
- Fine-grained read/write permissions
- Time-limited access tokens
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
