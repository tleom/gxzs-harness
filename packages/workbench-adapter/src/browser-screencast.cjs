// Chromium produces frames only when its compositor changes. One unsent frame
// and three outstanding receipts bound memory, even while SSH or a viewer stalls.
function createScreencast({ page, session, emit, nextId, onUnavailable = () => {}, ackTimeoutMs = 1500 }) {
  let enabled = false, pumping = false, latest, disposed = false, format = 'png', quality = 95, generation = 0
  const pending = new Map()
  let recent = [], idleTimer
  async function acknowledge(id) {
    const frame = pending.get(id)
    if (!frame) return
    pending.delete(id)
    clearTimeout(frame.timer)
    await session.send('Page.screencastFrameAck', { sessionId: frame.nativeId }).catch(() => {})
  }
  async function pump() {
    if (pumping || disposed) return
    pumping = true
    try {
      while (latest && enabled && !disposed) {
        const frame = latest
        latest = undefined
        try {
          const current = page.viewportSize()
          if (frame.generation !== generation || current.width !== frame.width || current.height !== frame.height ||
            await emit({ image: frame.data, mediaType: frame.mediaType, frame_id: frame.id }) === false)
            await acknowledge(frame.id)
        } catch { await acknowledge(frame.id) }
      }
    } finally { pumping = false }
  }
  async function configure() {
    const epoch = generation
    const { width, height } = page.viewportSize()
    await session.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false,
      screenWidth: width, screenHeight: height, viewport: { x: 0, y: 0, width, height, scale: 1 } })
    if (epoch !== generation || !enabled || disposed) return false
    await session.send('Page.startScreencast', { format, ...(format === 'jpeg' ? { quality } : {}),
      maxWidth: width, maxHeight: height, everyNthFrame: 4 })
    if (epoch !== generation || !enabled || disposed) { await session.send('Page.stopScreencast').catch(() => {}); return false }
    return true
  }
  let changingFormat = false
  async function changeFormat(next, nextQuality = 95) {
    if (changingFormat || disposed || !enabled) return
    changingFormat = true
    generation++
    latest = undefined
    try {
      await Promise.all([...pending.keys()].map(acknowledge))
      await session.send('Page.stopScreencast')
      format = next; quality = nextQuality; recent = []
      if (enabled && !disposed) await configure()
    } catch { enabled = false; onUnavailable() }
    finally { changingFormat = false }
  }
  async function receive(frame) {
    if (!enabled || disposed || changingFormat) {
      await session.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {})
      return
    }
    if (typeof frame.data !== 'string' || frame.data.length > Math.ceil(4 * 1024 * 1024 / 3) * 4) {
      await session.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {})
      if (format === 'jpeg' && quality === 85) return
      await changeFormat('jpeg', format === 'png' ? 95 : 85)
      return
    }
    const now = Date.now()
    recent = [...recent.filter(at => now - at < 600), now]
    if (format === 'png' && recent.length >= 4) {
      await session.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {})
      await changeFormat('jpeg')
      return
    }
    clearTimeout(idleTimer)
    if (format === 'jpeg') {
      idleTimer = setTimeout(() => { void changeFormat('png') }, 1500)
      idleTimer.unref?.()
    }
    const id = nextId()
    if (latest) void acknowledge(latest.id)
    while (pending.size >= 3) void acknowledge(pending.keys().next().value)
    const timer = setTimeout(() => { void acknowledge(id) }, ackTimeoutMs)
    timer.unref?.()
    pending.set(id, { nativeId: frame.sessionId, timer })
    latest = { id, data: frame.data, mediaType: `image/${format}`, generation, ...page.viewportSize() }
    void pump()
  }
  session.on?.('Page.screencastFrame', receive)
  return {
    async start() {
      if (disposed || typeof session.on !== 'function') return false
      if (enabled) return true
      enabled = true
      try { return await configure() }
      catch { enabled = false; return false }
    },
    async stop() {
      const wasEnabled = enabled
      generation++
      enabled = false
      clearTimeout(idleTimer)
      recent = []
      latest = undefined
      await Promise.all([...pending.keys()].map(acknowledge))
      if (wasEnabled) await session.send('Page.stopScreencast').catch(() => {})
    },
    async resize() {
      if (!enabled) return
      generation++
      try {
        await session.send('Page.stopScreencast')
        await configure()
      } catch (error) { enabled = false; onUnavailable(); throw error }
    },
    acknowledge,
    async dispose() {
      disposed = true
      session.off?.('Page.screencastFrame', receive)
      await this.stop()
    },
    get active() { return enabled },
  }
}

module.exports = { createScreencast }
