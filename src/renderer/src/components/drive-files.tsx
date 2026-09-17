import type { DriveFileSummary, DriveFolderSummary, DriveListing, DriveRoot } from '@shared/types'
import { cx } from '../lib/cx'
import { formatBytes, formatDateTime, mimeLabel, STATUS_LABELS } from '../lib/format'
import styles from './document-review.module.css'
import { TableSkeleton } from './loading-skeleton'

export const DRIVE_ROOTS: { id: DriveRoot; label: string }[] = [
  { id: 'my-drive', label: 'Il mio Drive' },
  { id: 'shared-with-me', label: 'Condivisi con me' },
  { id: 'shared-drives', label: 'Drive condivisi' }
]

const EMPTY: Record<DriveRoot, { title: string; hint: string }> = {
  'my-drive': {
    title: 'Il mio Drive è vuoto',
    hint: "L'account non ha cartelle, PDF o DOCX fuori dal cestino."
  },
  'shared-with-me': {
    title: 'Niente condiviso con te',
    hint: "Nessuno ha condiviso cartelle, PDF o DOCX con l'account."
  },
  'shared-drives': {
    title: 'Nessun Drive condiviso',
    hint: "L'account non fa parte di nessun Drive condiviso."
  }
}

interface Props {
  root: DriveRoot
  /** Le cartelle attraversate dalla radice, l'ultima è quella aperta. Vuoto = la radice. */
  path: DriveFolderSummary[]
  /** `null` finché la cartella aperta non è stata letta. */
  listing: DriveListing | null
  /** Id Drive del file che si sta scaricando in questo momento. */
  fetchingId: string | null
  busy: boolean
  /** `files.list` è in corso: l'elenco non è ancora né pieno né vuoto. */
  loading?: boolean
  onOpen: (file: DriveFileSummary) => void
  /** Spostarsi altrove: un'altra radice, una cartella più in alto o una più in basso. */
  onNavigate: (root: DriveRoot, path: DriveFolderSummary[]) => void
}

/**
 * Drive com'è, una cartella per volta: sottocartelle in cima e poi i file, solo metadati.
 *
 * Al doppio clic una cartella si apre, un file si scarica e va in revisione. Niente viene
 * scaricato per mostrare questa tabella, e non si legge l'albero intero: si scende un
 * livello per volta, come su Drive, invece di aspettare la visita di cartelle che nessuno
 * aprirà.
 */
export default function DriveFiles({
  root,
  path,
  listing,
  fetchingId,
  busy,
  loading = false,
  onOpen,
  onNavigate
}: Props) {
  const rootLabel = DRIVE_ROOTS.find((entry) => entry.id === root)?.label ?? ''

  return (
    <>
      <div className={styles.driveNav}>
        <div className={cx(styles.tabs, styles.tabsFlush)}>
          {DRIVE_ROOTS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={cx(styles.tab, root === entry.id && styles.tabActive)}
              disabled={busy}
              onClick={() => onNavigate(entry.id, [])}
            >
              {entry.label}
            </button>
          ))}
        </div>

        <nav className={styles.breadcrumb} aria-label="Percorso della cartella">
          {path.length === 0 ? (
            <span className={styles.crumbCurrent}>{rootLabel}</span>
          ) : (
            <button
              type="button"
              className={styles.crumb}
              disabled={busy}
              onClick={() => onNavigate(root, [])}
            >
              {rootLabel}
            </button>
          )}
          {path.map((folder, index) => (
            <span className={styles.crumbStep} key={folder.id}>
              <span className={styles.crumbSeparator} aria-hidden="true">
                ›
              </span>
              {index === path.length - 1 ? (
                <span className={styles.crumbCurrent} aria-current="page">
                  {folder.name}
                </span>
              ) : (
                <button
                  type="button"
                  className={styles.crumb}
                  disabled={busy}
                  onClick={() => onNavigate(root, path.slice(0, index + 1))}
                >
                  {folder.name}
                </button>
              )}
            </span>
          ))}
        </nav>
      </div>

      <Contents
        root={root}
        path={path}
        listing={listing}
        fetchingId={fetchingId}
        busy={busy}
        loading={loading}
        onOpen={onOpen}
        onNavigate={onNavigate}
      />
    </>
  )
}

function Contents({
  root,
  path,
  listing,
  fetchingId,
  busy,
  loading,
  onOpen,
  onNavigate
}: Required<Props>) {
  // Il contenuto già letto resta a schermo mentre si aggiorna la stessa cartella: sparire
  // e ricomparire è peggio di una riga stantia per il tempo di una `files.list`.
  if (!listing) {
    if (loading) return <TableSkeleton label="Leggo la cartella su Drive…" rows={6} />
    return (
      <div className={cx(styles.card, styles.empty)}>
        <div className={styles.emptyTitle}>Cartella non letta</div>
        <div>Riprova da «Aggiorna elenco Drive» nel menu dell&apos;account.</div>
      </div>
    )
  }

  if (listing.folders.length === 0 && listing.files.length === 0) {
    const empty =
      path.length > 0
        ? { title: 'Cartella vuota', hint: 'Qui dentro non ci sono cartelle, PDF o DOCX.' }
        : EMPTY[root]
    return (
      <div className={cx(styles.card, styles.empty)}>
        <div className={styles.emptyTitle}>{empty.title}</div>
        <div>{empty.hint}</div>
      </div>
    )
  }

  return (
    <div className={cx(styles.card, styles.tableWrap)}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Nome</th>
            <th>Tipo</th>
            <th>Dimensione</th>
            <th>Stato locale</th>
            <th>Revisione</th>
            <th>Modificato</th>
          </tr>
        </thead>
        <tbody>
          {listing.folders.map((folder) => (
            <tr
              key={folder.id}
              data-kind="folder"
              title="Doppio clic per aprire la cartella"
              onDoubleClick={() => !busy && onNavigate(root, [...path, folder])}
            >
              <td>
                <div className={cx(styles.fileName, styles.entryName)}>
                  <FolderIcon />
                  {folder.name}
                </div>
              </td>
              <td>Cartella</td>
              <td>
                <span className={styles.subtle}>—</span>
              </td>
              <td>
                <span className={styles.subtle}>—</span>
              </td>
              <td>
                <span className={styles.subtle}>—</span>
              </td>
              <td>{formatDateTime(folder.modifiedTime)}</td>
            </tr>
          ))}
          {listing.files.map((file) => (
            <tr
              key={file.id}
              data-kind="file"
              title="Doppio clic per scaricarlo e aprirlo"
              onDoubleClick={() => !busy && onOpen(file)}
            >
              <td>
                <div className={cx(styles.fileName, styles.entryName)}>
                  <FileIcon />
                  {file.name}
                </div>
                {fetchingId === file.id && <div className={styles.subtle}>Scarico e analizzo…</div>}
              </td>
              <td>{mimeLabel(file.mimeType)}</td>
              <td>{formatBytes(file.size)}</td>
              <td>
                <LocalState file={file} />
              </td>
              <td>
                {file.status ? (
                  <span className={cx(styles.badge, styles.status)}>
                    {STATUS_LABELS[file.status]}
                  </span>
                ) : (
                  <span className={styles.subtle}>—</span>
                )}
              </td>
              <td>{formatDateTime(file.modifiedTime)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function LocalState({ file }: { file: DriveFileSummary }) {
  if (file.stale) {
    return <span className={cx(styles.badge, styles.medium)}>Da aggiornare</span>
  }
  if (file.cached) {
    return <span className={cx(styles.badge, styles.high)}>In locale</span>
  }
  if (file.documentId) {
    return <span className={cx(styles.badge, styles.status)}>Analizzato, file rimosso</span>
  }
  return <span className={styles.subtle}>Non scaricato</span>
}

function FolderIcon() {
  return (
    <svg className={styles.entryIcon} viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M1.5 4A1.5 1.5 0 0 1 3 2.5h3.1l1.5 1.5H13A1.5 1.5 0 0 1 14.5 5.5v6.5A1.5 1.5 0 0 1 13 13.5H3A1.5 1.5 0 0 1 1.5 12Z"
        fill="currentColor"
      />
    </svg>
  )
}

function FileIcon() {
  return (
    <svg
      className={cx(styles.entryIcon, styles.entryIconFile)}
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <path
        d="M4 1.5h5.3L12.5 4.7V13A1.5 1.5 0 0 1 11 14.5H4A1.5 1.5 0 0 1 2.5 13V3A1.5 1.5 0 0 1 4 1.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  )
}
