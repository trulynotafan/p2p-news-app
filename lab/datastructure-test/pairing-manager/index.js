const b4a = require('b4a')
const BlindPairing = require('blind-pairing')
const extend = require('@geut/sodium-javascript-plus/extend')
const sodium = extend(require('sodium-universal'))

// Pairing manager. handles blind pairing for all data structures
// Works with datastructure-manager to automatically pair all registered structures

const create_pairing_manager = (ds_manager, swarm) => {
  let current_member = null
  let current_candidate = null

  // Create invite for pairing (member side)
  const create_invite = async (primary_key, primary_autobase_key) => {
    const all_keys = ds_manager.get_all_writer_keys()
    
    // Create invite with primary drive key (static method)
    const key_buffer = b4a.from(primary_key, 'hex')
    const invite_obj = BlindPairing.createInvite(key_buffer)
    const invite_code = b4a.toString(invite_obj.invite, 'base64')
    
    return {
      invite_code,
      invite: invite_obj,
      autobase_key: primary_autobase_key,
      all_keys
    }
  }

  // Setup member to handle pairing requests
  const setup_member = async (config) => {
    const { primary_discovery_key, invite, on_paired, username } = config
    const crypto = require('hypercore-crypto')
    
    const blind_pairing = new BlindPairing(swarm)
    await blind_pairing.ready()

    const handle_pairing_request = async (request) => {
      try {
        await request.open(invite.publicKey)

        const user_data = request.userData
        const structure_names = ds_manager.get_names()
        
        // Extract writer keys from user_data (32 bytes each)
        const writer_keys = {}
        let offset = 0
        
        for (const name of structure_names) {
          const config = ds_manager.get_config(name)
          const key_buffer = user_data.slice(offset, offset + 32)
          writer_keys[config.namespace] = b4a.toString(key_buffer, 'hex')
          offset += 32
        }

        // Add writers to all structures
        for (const name of structure_names) {
          const config = ds_manager.get_config(name)
          await ds_manager.add_writer(name, writer_keys[config.namespace])
        }
        
        console.log(`Added device as writer to: ${structure_names.join(', ')}`)

        // Prepare ALL structure keys + username to send via additional data
        const pairing_data = {
          username: username,
          keys: {}
        }
        
        for (const name of structure_names) {
          pairing_data.keys[name] = ds_manager.get_key(name)
        }
        
        // Encode additional data as JSON
        const additional_data = b4a.from(JSON.stringify(pairing_data))
        
        // Sign the additional data with the invite's keypair
        const invite_keypair = crypto.keyPair(invite.seed)
        const signature = crypto.sign(additional_data, invite_keypair.secretKey)
        
        // Confirm pairing with primary keys + ALL other keys in additional
        const drive_name = structure_names.find(n => 
          ds_manager.get_config(n).namespace === 'blog-files'
        )
        const metadata_name = structure_names.find(n => 
          ds_manager.get_config(n).namespace === 'blog-metadata'
        )
        
        request.confirm({
          key: b4a.from(ds_manager.get_key(drive_name), 'hex'),
          encryptionKey: b4a.from(ds_manager.get_key(metadata_name), 'hex'),
          additional: {
            data: additional_data,
            signature: signature
          }
        })
        
        if (on_paired) {
          await on_paired(writer_keys)
        }
      } catch (error) {
        console.error('Pairing error:', error.message)
      }
    }

    current_member = blind_pairing.addMember({
      discoveryKey: primary_discovery_key,
      onadd: handle_pairing_request
    })

    await current_member.ready()
    current_member.announce()
    
    return current_member
  }

  // Join with invite (candidate side)
  const join_with_invite = async (config) => {
    const { invite_code, store } = config
    
    const blind_pairing = new BlindPairing(swarm)
    await blind_pairing.ready()

    const invite_buffer = b4a.from(invite_code, 'base64')

    // Generate local writer keys for all structures
    const local_keys = await ds_manager.generate_local_writer_keys(store)
    
    // Concatenate all writer keys in order
    const structure_names = ds_manager.get_names()
    const key_buffers = structure_names.map(name => {
      const config = ds_manager.get_config(name)
      return local_keys[config.namespace]
    })
    
    const user_data = b4a.concat(key_buffers)

    return new Promise((resolve, reject) => {
      const handle_candidate_add = async (result) => {
        try {
          // Extract username and ALL structure keys from additional data
          let username = null
          let all_keys = {}
          if (result.data) {
            try {
              const pairing_data = JSON.parse(b4a.toString(result.data))
              username = pairing_data.username
              all_keys = pairing_data.keys
            } catch (err) {
              console.error('Error parsing pairing data:', err)
            }
          }
          
          resolve({
            drive_key: result.key,
            autobase_key: result.encryptionKey,
            username: username,
            all_structure_keys: all_keys
          })
        } catch (error) {
          console.error('Join error:', error.message)
          reject(error)
        }
      }

      const handle_candidate_ready_error = (error) => {
        console.error('Candidate ready error:', error)
        reject(error)
      }

      current_candidate = blind_pairing.addCandidate({
        invite: invite_buffer,
        userData: user_data,
        onadd: handle_candidate_add
      })

      current_candidate.ready().catch(handle_candidate_ready_error)
    })
  }

  // Close pairing
  const close = async () => {
    if (current_member) {
      await current_member.close()
      current_member = null
    }
    if (current_candidate) {
      await current_candidate.close()
      current_candidate = null
    }
  }

  return {
    create_invite,
    setup_member,
    join_with_invite,
    close
  }
}

module.exports = { create_pairing_manager }