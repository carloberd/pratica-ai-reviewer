import type { BoundingBox } from '@shared/types'

/**
 * Dove cade sulla pagina un pixel dell'immagine che la pagina contiene.
 *
 * Un PDF scansionato è una fotografia del foglio: l'OCR legge quella, e le coordinate che
 * restituisce sono pixel dell'immagine. Le evidenze, le righe salvate e il riquadro che il
 * revisore disegna stanno invece in unità di pagina pdf.js a scala 1, con origine in alto a
 * sinistra. Qui si costruisce la trasformazione che porta dalle une alle altre.
 *
 * In un PDF un'immagine si disegna nel quadrato unitario, ed è la matrice corrente a dire
 * dove finisce e quanto è grande; la riga 0 dell'immagine sta in alto, cioè a `v = 1`. La
 * matrice del viewport chiude il giro ribaltando l'asse y. Niente è indovinato: se la
 * matrice non si ricostruisce, le righe restano senza coordinate come prima.
 */

/** Matrice affine in convenzione PDF: `(x, y) → (a x + c y + e, b x + d y + f)`. */
export type Matrix = [number, number, number, number, number, number]

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

/** La matrice che applica prima `inner` e poi `outer`. */
export function compose(outer: Matrix, inner: Matrix): Matrix {
  const [a, b, c, d, e, f] = outer
  const [g, h, i, j, k, l] = inner
  return [
    a * g + c * h,
    b * g + d * h,
    a * i + c * j,
    b * i + d * j,
    a * k + c * l + e,
    b * k + d * l + f
  ]
}

function apply(matrix: Matrix, x: number, y: number): { x: number; y: number } {
  const [a, b, c, d, e, f] = matrix
  return { x: a * x + c * y + e, y: b * x + d * y + f }
}

/**
 * Da pixel dell'immagine a unità di pagina: il pixel diventa un punto del quadrato
 * unitario, `ctm` lo porta nello spazio utente e `viewport` in coordinate di pagina.
 */
export function imageToPage(
  ctm: Matrix,
  viewport: Matrix,
  width: number,
  height: number
): Matrix | null {
  if (width <= 0 || height <= 0) return null
  const pixelToUnit: Matrix = [1 / width, 0, 0, -1 / height, 0, 1]
  return compose(viewport, compose(ctm, pixelToUnit))
}

/** Il riquadro di una parola o di una riga come lo dà tesseract: pixel dell'immagine. */
export interface PixelBox {
  x0: number
  y0: number
  x1: number
  y1: number
}

/**
 * Il riquadro in unità di pagina, allineato agli assi. Si mappano tutti e quattro gli
 * angoli: una scansione ruotata o ribaltata ha una matrice che scambia gli assi, e due soli
 * angoli darebbero un riquadro girato al contrario. `null` se non resta un rettangolo.
 */
export function pageBox(matrix: Matrix, box: PixelBox): BoundingBox | null {
  const corners = [
    apply(matrix, box.x0, box.y0),
    apply(matrix, box.x1, box.y0),
    apply(matrix, box.x1, box.y1),
    apply(matrix, box.x0, box.y1)
  ]
  const xs = corners.map((corner) => corner.x)
  const ys = corners.map((corner) => corner.y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  const w = Math.max(...xs) - x
  const h = Math.max(...ys) - y
  if (!Number.isFinite(x) || !Number.isFinite(y) || w <= 0 || h <= 0) return null
  return { x, y, w, h }
}
