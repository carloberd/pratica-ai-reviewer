const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

/**
 * Firma ad-hoc del bundle macOS.
 *
 * Senza questo passo electron-builder lascia il pacchetto con la sola firma del
 * linker che arriva insieme al binario di Electron, mentre il bundle intorno è stato
 * rinominato e riempito di risorse: `codesign --verify` fallisce con «code has no
 * resources but signature indicates they must be present», e macOS lo presenta come
 * «l'applicazione è danneggiata». Succede solo sui pacchetti scaricati, perché
 * Gatekeeper valuta la firma davvero soltanto quando c'è l'attributo di quarantena:
 * la stessa build, avviata sulla macchina che l'ha prodotta, parte senza storie.
 *
 * Una firma ad-hoc rende il bundle valido e coerente. Non è una firma Developer ID:
 * al primo avvio macOS avverte comunque che lo sviluppatore non è verificato, ma da
 * lì si passa (vedi README). Per aprire l'app con un doppio clic e basta servono un
 * certificato Developer ID e la notarizzazione.
 */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  if (process.platform !== 'darwin') {
    console.warn('  • firma ad-hoc saltata: codesign esiste solo su macOS')
    return
  }

  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' })
  console.log(`  • firmato ad-hoc e verificato  ${appPath}`)
}
