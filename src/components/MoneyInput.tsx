/**
 * A money entry field: grouped digits while you type, and a short row of
 * round amounts to tap instead of typing at all.
 *
 * It is only the <input> plus its chips, not a whole `.field` -- it drops into
 * the labels, hints and toggles each form already has around its amounts.
 *
 * The value handed in and out is always plain ("1000000"); the separators
 * exist for the eyes only. That is why this is a text input rather than
 * type="number", which refuses to render them.
 */

import { amountSuggestions, groupAmount, toPlainAmount } from '../lib/format'

interface Props {
  id: string
  /** Plain digits, e.g. "1000000". */
  value: string
  /** Receives plain digits, never the grouped display string. */
  onChange: (plain: string) => void
  /** Sizes the suggestion chips; ignored when `suggestions` is given. */
  currency: string
  disabled?: boolean
  /** Overrides the currency-derived chips (deposits have their own floor). */
  suggestions?: number[]
}

export default function MoneyInput({ id, value, onChange, currency, disabled, suggestions }: Props) {
  const chips = suggestions ?? amountSuggestions(currency)

  return (
    <>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={groupAmount(value)}
        disabled={disabled}
        onChange={(e) => onChange(toPlainAmount(e.target.value))}
      />
      {!disabled && (
        <div className="chips">
          {chips.map((amount) => (
            <button
              key={amount}
              type="button"
              className="chip"
              // Fills the field and leaves it editable, like typing it would.
              onClick={() => onChange(String(amount))}
            >
              {groupAmount(String(amount))}
            </button>
          ))}
        </div>
      )}
    </>
  )
}
