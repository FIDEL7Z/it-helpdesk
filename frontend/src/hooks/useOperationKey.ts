import { useState } from 'react'

/**
 * Keeps one operation key per form submission attempt: retrying the same submission (after a
 * lost answer) sends the same key, so the API never applies it twice. A new key is made only
 * after a confirmed result.
 */
export function useOperationKey() {
  const [key, setKey] = useState(() => crypto.randomUUID())
  return { key, renew: () => setKey(crypto.randomUUID()) }
}
