import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

/**
 * I componenti si provano senza DOM: `react-dom/server` produce l'HTML, e le classi dei
 * CSS module (assenti sotto vitest) non contano. Quello che si verifica è il contenuto e
 * gli attributi `data-*` che i componenti espongono apposta.
 */
export function html(element: ReactElement): string {
  return renderToStaticMarkup(element)
}

/** Il testo visibile, senza tag e con gli spazi collassati. */
export function text(element: ReactElement): string {
  return html(element)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Quante volte compare un frammento nell'HTML. */
export function count(markup: string, fragment: string): number {
  return markup.split(fragment).length - 1
}
