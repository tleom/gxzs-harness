import { z } from 'zod'
import { pluginRecordOf } from '@deepseek-ai/dsh-session'

export const ACTIVE_EVENT = 'plugin:gxzs-tool-discovery/active'
export const PROJECTION_KEY = 'toolDiscovery'

const entrySchema = z.object({
  id: z.string().max(2048), name: z.string().max(256),
  version: z.string().max(2048), manifestVersion: z.string().max(2048),
  fingerprint: z.string().length(64),
})
export const activeStateSchema = z.object({
  version: z.literal(1), authorityKey: z.string().max(4096).nullable(),
  tools: z.array(entrySchema),
})

/** Whole-value native Session state; never grants authority to recovered IDs. */
export const discoveryProjection = {
  key: PROJECTION_KEY, stateVersion: 1, stateSchema: activeStateSchema,
  init: () => ({ version: 1, authorityKey: null, tools: [] }),
  apply(state, event) {
    const record = pluginRecordOf(event)
    if (record?.type !== ACTIVE_EVENT) return state
    const parsed = activeStateSchema.safeParse(record.data)
    return parsed.success ? parsed.data : { version: 1, authorityKey: null, tools: [] }
  },
}
