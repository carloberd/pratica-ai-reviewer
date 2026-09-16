import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { cx } from '../lib/cx'
import styles from './document-review.module.css'

export interface SelectOption {
  id: string
  label: string
  /** Testo secondario, mostrato sotto l'etichetta e incluso nella ricerca. */
  hint?: string
}

interface Props {
  value: string | null
  options: SelectOption[]
  /** Etichetta della voce che riporta il campo a «nessun valore». */
  emptyLabel: string
  disabled?: boolean
  searchPlaceholder?: string
  onChange: (value: string | null) => void
}

/**
 * Select con ricerca.
 *
 * Il registry PraticaAI ha centinaia di tipi: un menu nativo li elenca tutti e
 * costringe a scorrerli, mentre chi assegna un tipo sa già come si chiama. Qui si
 * scrive una parola e la lista si riduce.
 */
export default function SearchableSelect({
  value,
  options,
  emptyLabel,
  disabled = false,
  searchPlaceholder = 'Cerca…',
  onChange
}: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const listId = useId()

  const selected = options.find((option) => option.id === value) ?? null

  /** `null` è la voce che svuota il campo, in testa come nel menu nativo. */
  const visible = useMemo<Array<SelectOption | null>>(() => {
    const needle = normalize(query)
    const matching = needle
      ? options.filter((option) =>
          normalize(`${option.label} ${option.hint ?? ''}`).includes(needle)
        )
      : options
    return needle ? matching : [null, ...matching]
  }, [options, query])

  useEffect(() => {
    if (!open) return
    // Il menu si apre per scrivere: il cursore deve essere già nella ricerca.
    search.current?.focus()
    const onPointerDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  // La voce evidenziata deve restare visibile anche quando ci si muove da tastiera.
  useEffect(() => {
    if (!open) return
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${highlight}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [highlight, open])

  function choose(option: SelectOption | null) {
    setOpen(false)
    setQuery('')
    if ((option?.id ?? null) !== value) onChange(option?.id ?? null)
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Escape') {
      setOpen(false)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setHighlight((current) => {
        if (visible.length === 0) return 0
        return (current + step + visible.length) % visible.length
      })
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const option = visible[highlight]
      if (option !== undefined) choose(option)
    }
  }

  return (
    <div className={styles.combo} ref={root}>
      <button
        type="button"
        className={styles.comboButton}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => {
          setQuery('')
          setHighlight(0)
          setOpen((current) => !current)
        }}
      >
        <span className={cx(!selected && styles.comboPlaceholder)}>
          {selected ? selected.label : emptyLabel}
        </span>
        <span className={styles.comboCaret}>▾</span>
      </button>

      {open && (
        <div className={cx(styles.card, styles.comboPanel)}>
          <input
            className={styles.input}
            ref={search}
            type="search"
            value={query}
            placeholder={searchPlaceholder}
            onChange={(event) => {
              setQuery(event.target.value)
              setHighlight(0)
            }}
            onKeyDown={onKeyDown}
          />
          <div className={styles.comboList} id={listId} role="listbox" ref={listRef}>
            {visible.length === 0 && <div className={styles.comboEmpty}>Nessun tipo trovato.</div>}
            {visible.map((option, index) => (
              <button
                key={option?.id ?? '__empty__'}
                type="button"
                role="option"
                aria-selected={(option?.id ?? null) === value}
                data-index={index}
                className={cx(styles.comboOption, index === highlight && styles.comboOptionActive)}
                onMouseEnter={() => setHighlight(index)}
                onClick={() => choose(option)}
              >
                <span>{option ? option.label : emptyLabel}</span>
                {option?.hint && <span className={styles.comboHint}>{option.hint}</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/** Ricerca insensibile a maiuscole e accenti: «societa» deve trovare «Società». */
function normalize(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim()
}
