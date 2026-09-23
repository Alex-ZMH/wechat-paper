import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const EXPORT_SCRIPT = fileURLToPath(new URL('./word_exporter.py', import.meta.url))
const DOCX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

/**
 * Resolve a Python executable that can import python-docx.
 *
 * The project intentionally keeps document generation in a Python helper so
 * the core Node contracts do not acquire a second DOCX dependency.  Set
 * WORD_EXPORT_PYTHON when hosting the studio with a virtual environment.
 * Codex's bundled runtime is kept as a local-development fallback.
 */
function pythonCandidates(explicit) {
  const candidates = []
  if (explicit) candidates.push({ command: explicit, args: [] })
  if (process.env.WORD_EXPORT_PYTHON) candidates.push({ command: process.env.WORD_EXPORT_PYTHON, args: [] })
  if (process.env.PYTHON) candidates.push({ command: process.env.PYTHON, args: [] })
  if (process.env.PYTHON3) candidates.push({ command: process.env.PYTHON3, args: [] })

  // This path is present in the Codex desktop runtime used to run the local
  // studio. It is only a fallback; deployments should set the env var above.
  const userProfile = process.env.USERPROFILE || process.env.HOME || ''
  const bundled = userProfile
    ? join(userProfile, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python')
    : ''
  if (existsSync(bundled)) candidates.push({ command: bundled, args: [] })

  if (process.platform === 'win32') candidates.push({ command: 'py', args: ['-3'] })
  candidates.push({ command: 'python', args: [] })
  candidates.push({ command: 'python3', args: [] })
  return candidates
}

function safeTitle(payload) {
  const title = payload?.draft?.title || payload?.wechatPackage?.metadata?.title || '公众号文章'
  const text = String(title)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return text || '公众号文章'
}

/**
 * Choose the reader-facing filename.
 *
 * Exports are ordinary current-version documents, without an editorial
 * approval suffix. The server still validates saved workspace versions.
 */
function fileNameFor(payload) {
  return `${safeTitle(payload)}.docx`
}

function spawnExporter(candidate, input, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(candidate.command, [...candidate.args, EXPORT_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const output = []
    const diagnostics = []
    let settled = false
    let timer = null

    const fail = (error) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      reject(error)
    }
    const succeed = () => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(Buffer.concat(output))
    }

    child.on('error', (error) => {
      error.code = error.code || 'word_export_unavailable'
      fail(error)
    })
    child.stdout.on('data', (chunk) => output.push(Buffer.from(chunk)))
    child.stderr.on('data', (chunk) => diagnostics.push(Buffer.from(chunk)))
    child.on('close', (code, signal) => {
      if (code === 0) return succeed()
      const message = Buffer.concat(diagnostics).toString('utf8').trim() || `Word exporter exited with code ${code}${signal ? ` (${signal})` : ''}`
      const error = new Error(message)
      // Windows' command shim reports an unavailable executable as 9009
      // without emitting the usual ENOENT event. Treat that the same as a
      // missing candidate so a later configured/bundled interpreter can run.
      error.code = code === 9009 ? 'word_export_unavailable' : message.startsWith('word_export_reader_fields') ? 'word_export_reader_fields' : 'word_export_failed'
      error.exitCode = code
      fail(error)
    })
    timer = setTimeout(() => {
      child.kill()
      const error = new Error(`Word exporter timed out after ${timeoutMs} ms`)
      error.code = 'word_export_timeout'
      fail(error)
    }, timeoutMs)
    child.stdin.end(JSON.stringify(input))
  })
}

/**
 * Generate one reader-facing DOCX from the current structured article.
 *
 * The returned buffer contains only the generated document. Internal
 * provenance, review status and provider metadata affect neither its body nor
 * its core properties. The filename is derived from the reader-facing title.
 */
export async function exportWordDocument(payload, options = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    const error = new Error('Word export payload must be an object')
    error.code = 'word_export_invalid'
    throw error
  }

  // Malformed options never reach spawnExporter's destructuring parameter.
  const exportOptions = options && typeof options === 'object' && !Array.isArray(options) ? options : {}

  let lastError = null
  for (const candidate of pythonCandidates(exportOptions.pythonExecutable)) {
    try {
      const buffer = await spawnExporter(candidate, payload, exportOptions)
      if (!buffer.length) {
        const error = new Error('Word exporter produced an empty document')
        error.code = 'word_export_failed'
        throw error
      }
      return {
        buffer,
        fileName: fileNameFor(payload),
        contentType: DOCX_CONTENT_TYPE,
      }
    } catch (error) {
      lastError = error
      // Move to the next candidate only when the command is unavailable or it
      // cannot import the document helper. A real reader-safety/content error
      // must be surfaced immediately instead of being masked by another
      // interpreter's failure.
      if (!['ENOENT', 'spawn ENOENT', 'word_export_unavailable'].includes(error?.code) && error?.code !== 'MODULE_NOT_FOUND') {
        if (error?.code === 'word_export_failed' && /No module named ['"]?docx/u.test(error?.message || '')) continue
        throw error
      }
    }
  }
  const error = new Error(`No Python runtime with python-docx is available${lastError ? `: ${lastError.message}` : ''}`)
  error.code = 'word_export_unavailable'
  throw error
}

// Short alias for callers that treat this module as the generic download
// boundary; the explicit name above remains the canonical API.
export const exportWord = exportWordDocument

export { DOCX_CONTENT_TYPE }
