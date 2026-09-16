import { cx } from '../lib/cx'
import styles from './document-review.module.css'

/**
 * Segnaposto per i dati che stanno arrivando.
 *
 * Serve a non far dire alla UI una cosa falsa: finché la lettura non è finita non si
 * sa se la lista è vuota, e lo stato «non c'è niente» dato subito viene poi smentito
 * dalle righe che compaiono. Lo scheletro tiene anche l'altezza, così la tabella non
 * fa saltare la pagina quando i dati atterrano.
 */

/** Larghezze diverse per colonna: una griglia di barre identiche sembra un errore di rendering. */
const BAR_WIDTHS = ['82%', '60%', '45%', '55%', '50%', '68%']

export function TableSkeleton({ label, rows = 4 }: { label: string; rows?: number }) {
  return (
    <output className={cx(styles.card, styles.skeleton)} aria-live="polite">
      <div className={styles.skeletonLabel}>{label}</div>
      {Array.from({ length: rows }, (_, row) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: righe finte, senza identità propria
        <div className={styles.skeletonRow} key={row} aria-hidden="true">
          {BAR_WIDTHS.map((width) => (
            <span className={styles.skeletonBar} key={width} style={{ width }} />
          ))}
        </div>
      ))}
    </output>
  )
}

export function KpiSkeleton({ count = 4 }: { count?: number }) {
  return (
    <section className={styles.kpiGrid} aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: schede finte, senza identità propria
        <article className={cx(styles.card, styles.kpi)} key={index}>
          <span className={cx(styles.skeletonBar, styles.skeletonKpiLabel)} />
          <span className={cx(styles.skeletonBar, styles.skeletonKpiValue)} />
          <span className={cx(styles.skeletonBar, styles.skeletonKpiHint)} />
        </article>
      ))}
    </section>
  )
}
