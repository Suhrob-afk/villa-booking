/**
 * Copies text, resolving whether it actually worked.
 *
 * The Clipboard API is missing or refused in some Telegram WebViews, so this
 * falls back to a hidden textarea and execCommand. Callers report a false
 * result instead of claiming the copy happened.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Fall through to the legacy path.
  }

  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  area.remove()
  return ok
}
