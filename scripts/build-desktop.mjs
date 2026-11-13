// Monta desktop/app: interface compilada + servidor num arquivo só. Com --pack, gera release/CGL-win32-x64.
import { build } from 'esbuild'
import { execSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'desktop', 'app')
execSync('npm run build -w web', { cwd: root, stdio: 'inherit' })
rmSync(out, { recursive: true, force: true })
cpSync(join(root, 'web', 'dist'), join(out, 'web'), { recursive: true })
await build({
  entryPoints: [join(root, 'server', 'src', 'index.js')],
  outfile: join(out, 'server.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node22', minify: false,
  // dependências CommonJS dentro de um pacote ESM precisam de require/__dirname
  banner: { js: "import { createRequire as __cr } from 'node:module'; import { fileURLToPath as __fu } from 'node:url'; import { dirname as __dn } from 'node:path'; const require = __cr(import.meta.url); const __filename = __fu(import.meta.url); const __dirname = __dn(__filename);" },
})
console.log('desktop/app pronto')

// Túnel para a internet: binário oficial da Cloudflare, versão e SHA-256 fixos.
const CF = {
  version: '2026.10.7',
  sha256: '2493dbc168923bb3e59e5e7716f71deced92992eea9acd6e9d74f84ac7751343',
}
const cfPath = join(root, 'desktop', 'bin', 'cloudflared.exe')
const sha = (buf) => createHash('sha256').update(buf).digest('hex')
if (!existsSync(cfPath) || sha(readFileSync(cfPath)) !== CF.sha256) {
  console.log(`baixando cloudflared ${CF.version}...`)
  const res = await fetch(`https://github.com/cloudflare/cloudflared/releases/download/${CF.version}/cloudflared-windows-amd64.exe`)
  if (!res.ok) throw new Error(`download do cloudflared falhou: ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (sha(buf) !== CF.sha256) throw new Error('cloudflared: SHA-256 não confere, download descartado')
  mkdirSync(dirname(cfPath), { recursive: true })
  writeFileSync(cfPath, buf)
}
console.log('cloudflared conferido')

if (process.argv.includes('--pack')) {
  const { packager } = await import('@electron/packager')
  const [dir] = await packager({
    dir: join(root, 'desktop'), name: 'CGL', out: process.env.TAVERNA_OUT || join(root, 'release'), overwrite: true,
    platform: 'win32', arch: 'x64', asar: false, prune: false,
    ignore: [/^\/node_modules/],
    appCopyright: 'CGL', win32metadata: { ProductName: 'CGL', FileDescription: 'CGL' },
  })
  console.log('App em', dir)
}
