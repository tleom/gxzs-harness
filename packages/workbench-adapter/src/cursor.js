const CURSOR_PATTERN = /^(0|[1-9]\d*)-0$/

export function encodeCursor(sequence) {
  if (!Number.isSafeInteger(sequence) || sequence < 0)
    throw new TypeError('sequence must be a non-negative safe integer')
  return `${sequence}-0`
}

export function decodeCursor(value) {
  const text = value == null || value === '' ? '0-0' : String(value)
  const match = CURSOR_PATTERN.exec(text)
  if (!match) throw Object.assign(new Error('无效的事件游标'), { status: 400 })
  const sequence = Number(match[1])
  if (!Number.isSafeInteger(sequence))
    throw Object.assign(new Error('事件游标超出范围'), { status: 400 })
  return sequence
}
