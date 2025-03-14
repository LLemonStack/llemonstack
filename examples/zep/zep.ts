/**
 * Zep example to test if zep is working in the stack
 *
 * Usage:
 * ```bash
 * ZEP_API_SECRET=your-zep-api-key deno test/zep.ts
 * ```
 *
 * See https://github.com/getzep/zep-js/blob/oss/examples/memory/memory_example.ts
 *
 * Zep Community Edition SDK examples are a mess with frequently broken or
 * incorrect code online. For best source of truth, check the actual code in
 * `node_modules/@getzep/zep-js/examples`
 *
 * For deno on macOS, open `~/Library/Caches/deno/npm/registry.npmjs.org/@getzep/zep-js`
 * and look at the `examples` folder.
 */

import { ZepClient } from 'npm:@getzep/zep-js'
import type { CreateUserRequest, Message } from 'npm:@getzep/zep-js/api'
import { v4 as uuidv4 } from 'npm:uuid'
import { history } from './history.ts'

const API_KEY = Deno.env.get('ZEP_API_SECRET')
const BASE_URL = 'http://localhost:8010'

console.log('API_KEY', API_KEY)
if (!API_KEY) {
  throw new Error('ZEP_API_SECRET is not set')
}

function sleep(ms: number) {
  const date = Date.now()
  let currentDate = 0
  do {
    currentDate = Date.now()
  } while (currentDate - date < ms)
}

async function main() {
  // Create a zep client
  const client = new ZepClient({ apiKey: API_KEY as string, baseUrl: BASE_URL })

  // Create a user
  const userId = uuidv4()
  const userRequest: CreateUserRequest = {
    userId: `amy${userId}`,
    metadata: { role: 'admin' },
    email: 'amy@acme.com',
    firstName: 'Amy',
    lastName: 'Wu',
  }
  const user = await client.user.add(userRequest)
  console.debug('Created user ', user)

  // Example session ID
  const sessionID = uuidv4()

  // Add session associated with the above user
  try {
    await client.memory.addSession({
      sessionId: sessionID,
      metadata: { foo: 'bar' },
      userId: user.userId,
    })
    console.debug('Adding new session ', sessionID)
  } catch (error) {
    console.debug('Got error:', error)
  }

  // Get session
  try {
    const session = await client.memory.getSession(sessionID)
    console.debug('Retrieved session ', session)
  } catch (error) {
    console.debug('Got error:', error)
  }

  // Add memory. We could do this in a batch, but we'll do it one by one rather to
  // ensure that summaries and other artifacts are generated correctly.
  try {
    for (const { role, role_type, content } of history) {
      await client.memory.add(sessionID, {
        messages: [{ role, roleType: role_type, content }],
      })
    }
    console.debug('Added new memory for session ', sessionID)
  } catch (error) {
    console.debug('Got error:', error)
  }

  console.log('Sleeping for 30 seconds to let background tasks complete...')
  sleep(30000) // Sleep for 30 seconds
  console.log('Done sleeping!')

  // Get newly added memory
  try {
    console.debug('Getting memory for newly added memory with sessionid ', sessionID)
    const memory = await client.memory.get(sessionID)
    console.log('Memory: ', JSON.stringify(memory))
    if (memory?.messages) {
      memory.messages.forEach((message) => {
        console.debug(JSON.stringify(message))
      })
    }
  } catch (error) {
    console.error('Got error:', error)
  }

  // get session messages
  let sessionMessages: Message[] = []
  try {
    const sessionMessagesResult = await client.memory.getSessionMessages(sessionID, {
      limit: 10,
      cursor: 1,
    })
    console.debug('Session messages: ', JSON.stringify(sessionMessagesResult))
    if (sessionMessagesResult?.messages) {
      sessionMessages = sessionMessagesResult.messages
    }
  } catch (error) {
    console.error('Got error:', error)
  }

  const firstSessionsMessageId = sessionMessages[0].uuid

  // Update session message metadata
  try {
    const metadata = { metadata: { foo: 'bar' } }
    if (firstSessionsMessageId) {
      const updatedMessage = await client.memory.updateMessageMetadata(
        sessionID,
        firstSessionsMessageId,
        {
          metadata: metadata,
        },
      )
      console.debug('Updated message: ', JSON.stringify(updatedMessage))
    }
  } catch (error) {
    console.error('Got error:', error)
  }

  // Get session message

  try {
    if (firstSessionsMessageId) {
      const message = await client.memory.getSessionMessage(sessionID, firstSessionsMessageId)
      console.debug('Session message: ', JSON.stringify(message))
    }
  } catch (error) {
    console.error('Got error:', error)
  }

  // Search messages in memory
  try {
    const searchText = 'Name some books that are about dystopian futures.'
    console.debug('Searching memory...', searchText)

    const { results: searchResults } = await client.memory.searchSessions({
      userId: user.userId,
      text: searchText,
    })

    searchResults?.forEach((searchResult) => {
      console.debug('Search Result: ', JSON.stringify(searchResult.fact))
    })
  } catch (error) {
    console.error('Got error:', error)
  }
}

main()
