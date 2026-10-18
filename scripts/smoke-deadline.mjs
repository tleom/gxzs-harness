// Keep the event loop alive until a smoke assertion settles or reports its deadline.
export async function deadline(label, milliseconds, work) {
  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds}ms`)), milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export async function withCleanup(work, cleanup, reportFailure) {
  let primaryFailed = false
  try {
    return await work()
  } catch (error) {
    primaryFailed = true
    reportFailure('primary', error)
    throw error
  } finally {
    try {
      await cleanup()
    } catch (error) {
      reportFailure('cleanup', error)
      if (!primaryFailed) throw error
    }
  }
}
