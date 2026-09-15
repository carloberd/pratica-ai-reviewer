/**
 * Genera `build/icon.png`, da cui electron-builder ricava .icns e .ico.
 * Stessi colori della shell v5.2: fondo scuro, marchio verde.
 *
 *   node scripts/make-icon.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCanvas } from '@napi-rs/canvas'

const size = 1024
const canvas = createCanvas(size, size)
const ctx = canvas.getContext('2d')

ctx.fillStyle = '#0d1b20'
roundedRect(ctx, 0, 0, size, size, 224)
ctx.fill()

ctx.fillStyle = '#61d19f'
roundedRect(ctx, 232, 232, 560, 560, 128)
ctx.fill()

ctx.fillStyle = '#0d1b20'
ctx.font = 'bold 420px Helvetica'
ctx.textAlign = 'center'
ctx.textBaseline = 'middle'
ctx.fillText('P', size / 2, size / 2 + 20)

function roundedRect(context, x, y, width, height, radius) {
  context.beginPath()
  context.moveTo(x + radius, y)
  context.arcTo(x + width, y, x + width, y + height, radius)
  context.arcTo(x + width, y + height, x, y + height, radius)
  context.arcTo(x, y + height, x, y, radius)
  context.arcTo(x, y, x + width, y, radius)
  context.closePath()
}

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'build')
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'icon.png'), canvas.toBuffer('image/png'))
console.log('icona generata in build/icon.png')
