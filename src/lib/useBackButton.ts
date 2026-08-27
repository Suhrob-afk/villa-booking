import { useEffect } from 'react'
import { tg } from './telegram'

/**
 * Drives Telegram's native back button. Passing null hides it, which is what
 * the two root tabs do.
 */
export function useBackButton(onBack: (() => void) | null): void {
  useEffect(() => {
    const button = tg()?.BackButton
    if (!button) return
    if (!onBack) {
      button.hide()
      return
    }
    button.onClick(onBack)
    button.show()
    return () => {
      button.offClick(onBack)
      button.hide()
    }
  }, [onBack])
}
