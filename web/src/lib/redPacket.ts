export const DEFAULT_PACKET_COVER = '/assets/site/clover-mascot-packet.webp'

export function validPacketCover(value: string) {
  if (!value) return true
  if (/[\\\s\u0000-\u001f]/.test(value)) return false
  if (value.startsWith('/') && !value.startsWith('//')) return true
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password } catch { return false }
}

const pending = new Map<string, number>()
export const packetAttemptKey = (userId: number, activityId: number) => `clover:packet-attempt:${userId}:${activityId}`

/** Retain operation identity before sending. Never increment an uncertain attempt. */
export function readPacketAttempt(key: string): number | null {
  try {
    const value = Number(sessionStorage.getItem(key))
    if (Number.isSafeInteger(value) && value > 0) { pending.set(key, value); return value }
  } catch { /* Memory fallback survives dialog and route remounts. */ }
  return pending.get(key) ?? null
}

export function savePacketAttempt(key: string, seq: number | null) {
  if (seq === null) pending.delete(key)
  else pending.set(key, seq)
  try {
    if (seq === null) sessionStorage.removeItem(key)
    else sessionStorage.setItem(key, String(seq))
    return true
  } catch { return false }
}

/** A late response from a closed dialog must not erase a newer operation. */
export function clearPacketAttempt(key: string, seq: number) {
  if (readPacketAttempt(key) === seq) savePacketAttempt(key, null)
}
