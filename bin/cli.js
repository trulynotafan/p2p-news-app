#!/usr/bin/env bare

// Polyfill localStorage for bare/native environment
require('../src/node_modules/helpers/local-storage-shim')

const bare_peer = require('../src/node_modules/bare-peer/index.js')
const process = require('bare-process')

function parse_cli_args (args) {
  const parsed = {}

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--name') {
      parsed.name = args[i + 1]
      if (!parsed.name || parsed.name.startsWith('--')) {
        console.error('--name requires a name as an argument')
        process.exit(1)
      }
      i++
    } else if (args[i] === '--pair') {
      parsed.pair_mode = true
    }
  }

  return parsed
}

function validate_cli_args (opts) {
  if (opts.pair_mode) {
    // In pair mode, we'll get the username from the invite
    if (!opts.name) {
      const hostname = process.env.HOSTNAME || 'unknown'
      const timestamp = Date.now().toString().slice(-4)
      opts.name = `temp-${hostname}-${timestamp}`
    }
  } else {
    // Normal mode - create new identity
    if (!opts.name) {
      const hostname = process.env.HOSTNAME || 'unknown'
      const timestamp = Date.now().toString().slice(-4)
      opts.name = `${hostname}-${timestamp}`
      console.log(`Generated device name: ${opts.name}`)
    }
  }
  return opts
}

async function show_menu () {
  console.log('\n=== P2P Blog Menu ===')
  console.log('1. Create new blog post')
  console.log('2. View posts (mine + subscribed)')
  console.log('3. Manage subscriptions')
  console.log('4. Create invite code (for pairing devices)')
  console.log('5. View my profile')
  console.log('6. View paired devices')
  console.log('7. Exit')
  console.log('\nEnter your choice (1-7): ')
}

async function show_discovered_peers (peer) {
  const { blog_helper } = peer
  const peer_list = []
  let i = 1

  console.log('\n=== Available Peers ===')

  const discovered_blogs = await blog_helper.get_discovered_blogs()
  const subscribed_blogs = await blog_helper.get_peer_blogs()

  for (const [key, data] of discovered_blogs.entries()) {
    if (data.username && data.title && data.drive_key) {
      const is_subscribed = subscribed_blogs.has(key)
      console.log(`${i}. ${data.username} [${key.slice(0, 8)}]${is_subscribed ? ' [Subscribed]' : ''}`)
      console.log(`   Blog: "${data.title}"`)
      peer_list.push({
        peer_key: key,
        username: data.username,
        title: data.title,
        is_subscribed
      })
      i++
    }
  }

  if (peer_list.length === 0) {
    console.log('No peers with blogs available')
    return null
  }

  return peer_list
}

async function handle_user_input (input, peer) {
  const { blog_helper } = peer

  switch (input.trim()) {
  case '1':
    console.log('\n=== Create New Post ===')
    console.log('Enter title:')
    const title = await read_line()
    console.log('Enter content:')
    const content = await read_line()

    await blog_helper.create_post(title, content)
    console.log('\nPost created')
    break

  case '2':
    console.log('\n=== All Posts ===')

    // Show my posts first
    const my_posts = await blog_helper.get_my_posts()
    const my_username = await blog_helper.get_blog_username()

    if (my_posts.length > 0) {
      console.log(`\n--- ${my_username}'s Blog (You) ---`)
      for (const post of my_posts) {
        console.log(`\n${post.title}`)
        if (post.device_name) console.log(`   Device: ${post.device_name}`)
        console.log(`   ${post.content}`)
        console.log(`   Posted: ${new Date(post.created).toLocaleString()}`)
      }
    }

    // Show subscribed peers' posts
    const subscribed_blogs = await blog_helper.get_peer_blogs()
    let has_subscribed_posts = false

    for (const [key, blog] of subscribed_blogs.entries()) {
      if (blog.posts && blog.posts.length > 0) {
        has_subscribed_posts = true
        console.log(`\n--- ${blog.username}'s Blog ---`)
        for (const post of blog.posts) {
          console.log(`\n${post.title}`)
          if (post.device_name) console.log(`   Device: ${post.device_name}`)
          console.log(`   ${post.content}`)
          console.log(`   Posted: ${new Date(post.created).toLocaleString()}`)
        }
      }
    }

    if (my_posts.length === 0 && !has_subscribed_posts) {
      console.log('No posts available')
    }
    break

  case '3':
    console.log('\n=== Manage Subscriptions ===')

    const discovered_blogs = await blog_helper.get_discovered_blogs()
    const subscribed_blogs_list = await blog_helper.get_peer_blogs()

    const all_peers = []
    let peer_index = 1

    // Show subscribed peers first
    if (subscribed_blogs_list.size > 0) {
      console.log('\nSubscribed:')
      for (const [key, blog] of subscribed_blogs_list.entries()) {
        console.log(`  ${peer_index}. ${blog.username} [${key.slice(0, 8)}] [Subscribed]`)
        console.log(`     Posts: ${blog.posts?.length || 0}`)
        all_peers.push({ key, username: blog.username, is_subscribed: true })
        peer_index++
      }
    }

    // Show discovered (not subscribed) peers
    const unsubscribed = []
    for (const [key, data] of discovered_blogs.entries()) {
      if (!subscribed_blogs_list.has(key) && data.username) {
        unsubscribed.push({ key, username: data.username, title: data.title })
      }
    }

    if (unsubscribed.length > 0) {
      console.log('\nDiscovered:')
      for (const peer of unsubscribed) {
        console.log(`  ${peer_index}. ${peer.username} [${peer.key.slice(0, 8)}]`)
        console.log(`     Blog: "${peer.title}"`)
        all_peers.push({ key: peer.key, username: peer.username, is_subscribed: false })
        peer_index++
      }
    }

    if (all_peers.length === 0) {
      console.log('No peers discovered yet')
      break
    }

    console.log('\nOptions:')
    console.log('  Enter number to subscribe/unsubscribe')
    console.log('  0 to go back')
    console.log('\nChoice: ')

    const sub_choice = await read_line()
    const sub_num = parseInt(sub_choice.trim())

    if (sub_num === 0 || sub_num < 1 || sub_num > all_peers.length) {
      break
    }

    const selected_peer = all_peers[sub_num - 1]

    if (selected_peer.is_subscribed) {
      // Unsubscribe
      await blog_helper.unsubscribe(selected_peer.key)
      console.log(`\nUnsubscribed from ${selected_peer.username}`)
    } else {
      // Subscribe
      console.log(`\nSubscribing to ${selected_peer.username}...`)
      const success = await peer.subscribe(selected_peer.key)
      if (success) {
        console.log(`\nSuccessfully subscribed to ${selected_peer.username}!`)
      } else {
        console.log(`\n✗ Failed to subscribe to ${selected_peer.username}`)
      }
    }
    break

  case '4':
    console.log('\n=== Create Invite Code ===')
    try {
      const invite_code = await peer.create_invite()
      console.log('\nInvite code created!')
      console.log('Share this code with another device:')
      console.log(`\n${invite_code}\n`)
      console.log('WARNING: Keep this terminal open while the other device joins')
    } catch (err) {
      console.log('Failed to create invite:', err.message)
    }
    break

  case '5':
    console.log('\n=== My Profile ===')
    const profile = await blog_helper.get_profile()
    if (profile) {
      console.log(`Name: ${profile.name}`)
      console.log(`Avatar: ${profile.avatar}`)
    } else {
      console.log('No profile found')
    }

    const username = await blog_helper.get_blog_username()
    console.log(`Blog Username: ${username || 'N/A'}`)
    console.log(`Autobase Key: ${blog_helper.get_autobase_key()?.slice(0, 16)}...`)
    console.log(`Local Writer Key: ${blog_helper.get_local_key()?.slice(0, 16)}...`)
    break

  case '6':
    console.log('\n=== Paired Devices ===')
    const devices = await blog_helper.get_paired_devices()
    if (devices.length === 0) {
      console.log('No paired devices yet')
      break
    }

    for (const device of devices) {
      console.log(`\n${device.name}`)
      console.log(`  Added: ${device.added_date}`)
      console.log(`  Metadata Writer: ${device.metadata_writer.slice(0, 16)}...`)
    }
    break

  case '7':
    console.log('\nGoodbye!')
    process.exit(0)
    break

  default:
    console.log('\nInvalid choice')
  }
}

function read_line () {
  return new Promise((resolve) => {
    const chunks = []
    process.stdin.on('data', (chunk) => {
      chunks.push(chunk)
      if (chunk.includes('\n')) {
        process.stdin.removeAllListeners('data')
        resolve(Buffer.concat(chunks).toString().trim())
      }
    })
  })
}

async function start_native (peer) {
  console.log('\nStarting native peer')
  console.log('Discovering peers...')

  // Listen for updates (new posts, subscriptions, etc.)
  peer.blog_helper.on_update(() => {
    console.log('\n[UPDATE] New content available - view posts to see updates')
  })

  while (true) {
    await show_menu()
    const choice = await read_line()
    await handle_user_input(choice, peer)
  }
}

const cli_args = process.argv.slice(2)
const parsed_args = parse_cli_args(cli_args)
const validated_args = validate_cli_args(parsed_args)

// Handle pair mode BEFORE starting peer
if (validated_args.pair_mode) {
  console.log('=== Pairing Mode ===')
  console.log('Enter the invite code from your other device:')

  read_line().then(async (invite_code) => {
    if (!invite_code || invite_code.trim().length === 0) {
      console.error('Invalid invite code')
      process.exit(1)
    }

    console.log('\nStarting peer for pairing...')

    try {
      const peer = await bare_peer.start(validated_args)

      // Wait for swarm to flush before pairing
      console.log('\nWaiting for swarm to be ready...')
      await peer.flush_promise
      console.log('Swarm ready!')

      console.log('\nJoining with invite code...')
      const success = await peer.join_with_invite(invite_code.trim())

      if (success) {
        console.log('\nSuccessfully paired!')

        // Get the username from the blog
        const username = await peer.blog_helper.get_blog_username()
        console.log(`Joined as: ${username}`)

        // Now start the normal menu
        await start_native(peer)
      } else {
        console.error('\nFailed to pair with the invite code')
        process.exit(1)
      }
    } catch (err) {
      console.error('Failed to start peer:', err)
      process.exit(1)
    }
  })
} else {
  // Normal mode - start peer immediately
  console.log('Starting peer:', validated_args.name)

  bare_peer.start(validated_args)
    .then(async (peer) => {
      await start_native(peer)
    })
    .catch(err => {
      console.error('Failed to start peer:', err)
      process.exit(1)
    })
}
