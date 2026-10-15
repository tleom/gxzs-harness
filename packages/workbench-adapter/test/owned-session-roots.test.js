import { expect, it } from 'vitest'
import { ownedSessionRoots } from '../src/owned-session-roots.js'
it('uses real native parent chains for live rows and cold query headers and excludes deleted roots, cycles and archived ancestors', () => {
  const chats = [{id:'chat',sessionId:'root'},{id:'archived-chat',sessionId:'archived'}]
  const records = [{sessionId:'child',parentSessionId:'root'}, {header:{id:'grand',parentSession:'child'}},
    {sessionId:'deleted-child',parentSessionId:'deleted'}, {sessionId:'a',parentSessionId:'b'}, {sessionId:'b',parentSessionId:'a'},
    {sessionId:'archived-child',parentSessionId:'archived'}]
  const owned = ownedSessionRoots(chats,records,new Set(['archived']))
  expect([...owned.keys()]).toEqual(['root','child','grand'])
  expect(owned.get('grand')).toEqual({chatId:'chat',rootSessionId:'root',parentSessionId:'child'})
})
