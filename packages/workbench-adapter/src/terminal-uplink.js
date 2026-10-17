import { httpError } from './http.js'

/** Bounded HTTP-to-native stream carrier. Native acknowledgements own input acceptance. */
export class TerminalUplink {
  constructor({ maxBytes, signal, abort, timeoutMs = 30000 }) {
    Object.assign(this, { maxBytes, signal, abort, timeoutMs })
    this.queue = []
    this.pending = new Map()
    this.sequence = 0
    this.bytes = 0
    this.stop = () => this.close(signal.reason)
    signal.addEventListener('abort', this.stop, { once: true })
    if (signal.aborted) this.stop()
  }
  send(command) {
    if (this.closed) return Promise.reject(this.closed)
    const value = { ...command, sequence: this.sequence + 1 }
    const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8')
    if (this.pending.size >= 128 || this.bytes + bytes > this.maxBytes)
      return Promise.reject(httpError(429, '终端输入队列已满，请稍后重试'))
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // The provider may already have accepted this command. Never replay it.
        this.abort(httpError(504, '终端输入确认超时，请检查终端后重新连接'))
      }, this.timeoutMs)
      timer.unref?.()
      this.pending.set(value.sequence, { resolve, reject, timer, bytes })
    })
    this.sequence = value.sequence
    this.bytes += bytes
    this.queue.push(value)
    this.wake?.()
    return promise
  }
  acknowledge(frame) {
    const pending = this.pending.get(frame.sequence)
    if (!pending || frame.sequence !== this.pending.keys().next().value)
      throw new Error('Native terminal acknowledgement is out of order')
    this.pending.delete(frame.sequence)
    clearTimeout(pending.timer)
    this.bytes -= pending.bytes
    if (frame.refusal) pending.reject(httpError(409, '当前终端不能接受输入，请重新连接'))
    else pending.resolve()
  }
  close(reason = httpError(409, '终端连接已结束，请重新连接')) {
    if (this.closed) return
    this.closed = reason instanceof Error ? reason : new Error(String(reason))
    this.signal.removeEventListener('abort', this.stop)
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(this.closed)
    }
    this.pending.clear()
    this.queue.length = 0
    this.bytes = 0
    this.wake?.()
  }
  [Symbol.asyncIterator]() {
    return {
      next: async () => {
        while (!this.closed && !this.queue.length) await new Promise(resolve => { this.wake = resolve })
        this.wake = undefined
        return this.closed ? { done: true } : { done: false, value: this.queue.shift() }
      },
      return: async () => { this.close(); return { done: true } },
    }
  }
}
