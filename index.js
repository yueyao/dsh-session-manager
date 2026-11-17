/**
 * Host half of the DSH Session Manager plugin (`dsh-session-manager`).
 *
 * Responsibilities:
 *  - enumerate every history session on disk (across all working directories);
 *  - `POST /session-manager/api/<method>` HTTP JSON API for the client half;
 *  - four `session_manager_*` agent tools registered on `ctx.tools`;
 *  - archive / restore (rename into a global archive dir, reversible) and
 *    delete (rm -rf, irreversible) implemented on the filesystem layer,
 *    because `ctx.sessionPersistence` exposes no delete/archive methods.
 *
 * Session storage layout (confirmed against the real harness):
 *   DSH_HOME/sessions/<cwd-encoded>/<session-id>/
 *     ├── session.lock           # empty file, ownership marker
 *     └── session.v4.jsonl.zstd  # zstd-compressed append-only JSONL event log
 *
 * <cwd-encoded> encodes the working directory: `/` → `-`, non-ASCII chars →
 * `~XXXX~` hex. <session-id> appears in two conventions observed on disk:
 * a bare UUID (`01098df8-...`) or a `session-<uuid>` prefix form.
 *
 * Only Node built-ins are used. Every registration is wrapped in `ctx.effect`
 * so disposing the plugin fiber removes tools and the route cleanly.
 */

import { promises as fsp } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

export const name = 'dsh-session-manager'
export const inject = ['tools', 'webServer', 'connection']

const API_PREFIX = '/session-manager/api'
const MAX_BODY_BYTES = 8 * 1024 * 1024
const MAX_IDS_PER_OP = 500

/* ------------------------------------------------------------------ */
/* tiny helpers                                                        */
/* ------------------------------------------------------------------ */

function nowIso() {
  return new Date().toISOString()
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(error) {
  if (error instanceof Error && typeof error.message === 'string') return error.message
  return String(error)
}

function safeCall(fn) {
  try {
    fn()
  } catch {
    /* ignore */
  }
}

function logInfo(ctx, message) {
  try {
    ctx.logger?.info?.(`dsh-session-manager: ${message}`)
  } catch {
    /* logging must never throw */
  }
}

function logWarn(ctx, message) {
  try {
    ctx.logger?.warn?.(`dsh-session-manager: ${message}`)
  } catch {
    /* ignore */
  }
}

function logError(ctx, error) {
  try {
    ctx.logger?.error?.(`dsh-session-manager: ${errorMessage(error)}`)
  } catch {
    /* ignore */
  }
}

/** Error type that carries an HTTP status + envelope code. */
class ApiError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}

function badRequest(message) {
  return new ApiError('bad-request', message, 400)
}

function notFound(message) {
  return new ApiError('not-found', message, 404)
}

/* ------------------------------------------------------------------ */
/* path resolution                                                     */
/* ------------------------------------------------------------------ */

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv.trim())
  return path.join(os.homedir(), 'Library', 'Application Support', 'dsh-desktop', 'harness')
}

function sessionsRoot() {
  return path.join(dshHome(), 'sessions')
}

function archiveRoot() {
  return path.join(dshHome(), 'archive', 'sessions')
}

function archiveIndexPath() {
  return path.join(dshHome(), 'archive', 'sessions-index.json')
}

/**
 * Decode a <cwd-encoded> directory name back into a best-effort working
 * directory path. The harness encodes `/` as `-` and non-ASCII as `~XXXX~`.
 * Because the encoding is lossy (a literal `-` in the path is ambiguous with
 * a separator), this is only used for display — operations act on the encoded
 * directory names directly and never on decoded paths.
 */
function decodeCwd(encoded) {
  let text = encoded
  // Hex-escaped Unicode (e.g. ~51FA~ -> 出) first, then the `-` → `/` mapping.
  text = text.replace(/~([0-9A-Fa-f]{4})~/g, (_, hex) => {
    try {
      return String.fromCodePoint(parseInt(hex, 16))
    } catch {
      return _
    }
  })
  // A leading `--` marks the absolute-path form (e.g. `--Users-...`); the
  // first two dashes represent the empty segment before the leading `/`.
  return text.replace(/-/g, '/')
}

/**
 * Resolve a <session-id> reference to a concrete on-disk directory path,
 * guarding against path traversal. Returns null when not found.
 */
async function resolveSessionDir(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') return null
  const id = sessionId.trim()
  // Reject anything with a path separator or `..` — ids are bare names.
  if (id.includes('/') || id.includes('\\') || id === '.' || id === '..') return null

  const root = sessionsRoot()
  let entries
  try {
    entries = await fsp.readdir(root, { withFileTypes: true })
  } catch {
    return null
  }
  for (const cwdEntry of entries) {
    if (!cwdEntry.isDirectory()) continue
    const candidate = path.join(root, cwdEntry.name, id)
    try {
      const stat = await fsp.stat(candidate)
      if (stat.isDirectory()) return candidate
    } catch {
      /* try next cwd */
    }
  }
  return null
}

/** Ensure a resolved path stays inside an allowed root (defense in depth). */
function assertInside(root, target) {
  const rel = path.relative(root, target)
  if (rel === '') return
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ApiError('forbidden', 'path escapes allowed root', 403)
  }
}

/* ------------------------------------------------------------------ */
/* archive index                                                       */
/* ------------------------------------------------------------------ */

async function readArchiveIndex() {
  try {
    const text = await fsp.readFile(archiveIndexPath(), 'utf8')
    const parsed = JSON.parse(text)
    if (isPlainObject(parsed) && Array.isArray(parsed.entries)) return parsed.entries
    return []
  } catch {
    return []
  }
}

async function writeArchiveIndex(entries) {
  const file = archiveIndexPath()
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const temp = path.join(
    path.dirname(file),
    `.sessions-index.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`,
  )
  try {
    await fsp.writeFile(temp, `${JSON.stringify({ entries }, null, 2)}\n`, 'utf8')
    await fsp.rename(temp, file)
  } catch (error) {
    try {
      await fsp.rm(temp, { force: true })
    } catch {
      /* ignore */
    }
    throw error
  }
}

/* ------------------------------------------------------------------ */
/* session model                                                       */
/* ------------------------------------------------------------------ */

function sessionMetaFromDir(cwdName, sessionId, dirPath, stat) {
  return {
    id: sessionId,
    cwd: decodeCwd(cwdName),
    cwdEncoded: cwdName,
    updatedAt: stat.mtime.toISOString(),
    sizeBytes: stat.size,
    running: false,
  }
}

/** True if the directory contains a session.lock marker AND a data file. */
async function isLiveSession(dirPath) {
  try {
    const entries = await fsp.readdir(dirPath)
    const hasLock = entries.includes('session.lock')
    const hasData = entries.some((e) => e === 'session.v4.jsonl.zstd')
    return hasData && hasLock
  } catch {
    return false
  }
}

async function isRunning(dirPath) {
  try {
    const lockPath = path.join(dirPath, 'session.lock')
    const stat = await fsp.stat(lockPath)
    // A freshly-touched lock (within ~30s) suggests an active owner; this is a
    // heuristic — the authoritative signal is `sessionPersistence` ownership.
    return Date.now() - stat.mtimeMs < 30_000
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ */
/* store                                                               */
/* ------------------------------------------------------------------ */

function createStore(ctx) {
  let mutationChain = Promise.resolve()

  function exclusive(task) {
    const run = mutationChain.then(task, task)
    mutationChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  function sessionPersistence() {
    try {
      const svc = typeof ctx.get === 'function' ? ctx.get('sessionPersistence') : undefined
      if (svc !== undefined && svc !== null) return svc
    } catch {
      /* ignore */
    }
    try {
      const fallback = ctx.sessionPersistence
      if (fallback !== undefined && fallback !== null) return fallback
    } catch {
      /* ignore */
    }
    return null
  }

  /** Best-effort metadata cross-check from the persistence service. */
  async function enrichWithService(items) {
    const svc = sessionPersistence()
    if (svc === null) return items
    try {
      if (typeof svc.list === 'function') {
        const ids = await svc.list()
        if (Array.isArray(ids)) {
          const idSet = new Set(ids.map(String))
          for (const item of items) {
            if (idSet.has(item.id) || idSet.has(item.id.replace(/^session-/, ''))) {
              item.running = true
            }
          }
        }
      }
    } catch (error) {
      logWarn(ctx, `sessionPersistence.list() failed: ${errorMessage(error)}`)
    }
    return items
  }

  async function enumerate() {
    const root = sessionsRoot()
    const out = []
    let cwdEntries
    try {
      cwdEntries = await fsp.readdir(root, { withFileTypes: true })
    } catch {
      return out
    }
    for (const cwdEntry of cwdEntries) {
      if (!cwdEntry.isDirectory()) continue
      const cwdDir = path.join(root, cwdEntry.name)
      let sessionEntries
      try {
        sessionEntries = await fsp.readdir(cwdDir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const sessionEntry of sessionEntries) {
        if (!sessionEntry.isDirectory()) continue
        const dirPath = path.join(cwdDir, sessionEntry.name)
        try {
          const stat = await fsp.stat(dirPath)
          const meta = sessionMetaFromDir(cwdEntry.name, sessionEntry.name, dirPath, stat)
          meta.running = await isRunning(dirPath)
          out.push(meta)
        } catch {
          /* skip unreadable dir */
        }
      }
    }
    return enrichWithService(out)
  }

  async function enumerateArchived() {
    const index = await readArchiveIndex()
    return index.map((entry) => ({
      id: entry.id,
      cwd: entry.cwd ?? '',
      cwdEncoded: entry.cwdEncoded ?? '',
      updatedAt: entry.archivedAt ?? '',
      sizeBytes: entry.sizeBytes ?? 0,
      running: false,
      archived: true,
      archivedAt: entry.archivedAt ?? '',
      reason: entry.reason ?? '',
    }))
  }

  async function listState() {
    const [sessions, archived] = await Promise.all([enumerate(), enumerateArchived()])
    sessions.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
    archived.sort((a, b) => (b.archivedAt || '').localeCompare(a.archivedAt || ''))
    return { sessions, archived, total: sessions.length, archivedCount: archived.length }
  }

  async function archiveSessions(ids) {
    validateIds(ids)
    const results = []
    for (const id of ids) {
      try {
        const dir = await resolveSessionDir(id)
        if (dir === null) {
          results.push({ id, ok: false, error: 'not-found' })
          continue
        }
        if (await isRunning(dir)) {
          results.push({ id, ok: false, error: 'running' })
          continue
        }
        const root = sessionsRoot()
        assertInside(root, dir)
        const rel = path.relative(root, dir)
        const target = path.join(archiveRoot(), rel)
        await fsp.mkdir(path.dirname(target), { recursive: true })
        // Same-volume rename is atomic; data file is preserved verbatim.
        await fsp.rename(dir, target)

        // Record an index entry (source path encoded for restore).
        const stat = await safeStatDir(target)
        const entries = await readArchiveIndex()
        entries.push({
          id,
          cwd: decodeCwd(path.dirname(rel)),
          cwdEncoded: path.dirname(rel),
          archivedAt: nowIso(),
          sizeBytes: stat?.size ?? 0,
          reason: 'manual',
        })
        await writeArchiveIndex(entries)
        results.push({ id, ok: true })
      } catch (error) {
        logWarn(ctx, `archive ${id} failed: ${errorMessage(error)}`)
        results.push({ id, ok: false, error: error instanceof ApiError ? error.code : 'internal' })
      }
    }
    return { results }
  }

  async function restoreSessions(ids) {
    validateIds(ids)
    const results = []
    const entries = await readArchiveIndex()
    for (const id of ids) {
      try {
        const entry = entries.find((e) => e.id === id)
        if (!entry) {
          results.push({ id, ok: false, error: 'not-archived' })
          continue
        }
        const archivedDir = path.join(archiveRoot(), entry.cwdEncoded, id)
        const targetDir = path.join(sessionsRoot(), entry.cwdEncoded, id)
        assertInside(archiveRoot(), archivedDir)
        assertInside(sessionsRoot(), targetDir)
        await fsp.mkdir(path.dirname(targetDir), { recursive: true })
        await fsp.rename(archivedDir, targetDir)
        // Drop the index entry on success.
        await writeArchiveIndex(entries.filter((e) => e.id !== id))
        results.push({ id, ok: true })
      } catch (error) {
        logWarn(ctx, `restore ${id} failed: ${errorMessage(error)}`)
        results.push({ id, ok: false, error: error instanceof ApiError ? error.code : 'internal' })
      }
    }
    return { results }
  }

  async function deleteSessions(ids) {
    validateIds(ids)
    const results = []
    for (const id of ids) {
      try {
        const dir = await resolveSessionDir(id)
        if (dir === null) {
          results.push({ id, ok: false, error: 'not-found' })
          continue
        }
        if (await isRunning(dir)) {
          results.push({ id, ok: false, error: 'running' })
          continue
        }
        const root = sessionsRoot()
        assertInside(root, dir)
        await fsp.rm(dir, { recursive: true, force: true })
        results.push({ id, ok: true })
      } catch (error) {
        logWarn(ctx, `delete ${id} failed: ${errorMessage(error)}`)
        results.push({ id, ok: false, error: error instanceof ApiError ? error.code : 'internal' })
      }
    }
    return { results }
  }

  return {
    api: {
      list: async () => listState(),
      archive: async (body) => archiveSessions(body?.ids ?? []),
      restore: async (body) => restoreSessions(body?.ids ?? []),
      delete: async (body) => deleteSessions(body?.ids ?? []),
    },
  }
}

function validateIds(ids) {
  if (!Array.isArray(ids)) throw badRequest('ids 必须是数组')
  if (ids.length === 0) throw badRequest('ids 不能为空')
  if (ids.length > MAX_IDS_PER_OP) throw badRequest(`一次最多 ${MAX_IDS_PER_OP} 个会话`)
  for (const id of ids) {
    if (typeof id !== 'string' || id.trim() === '') throw badRequest('ids 含非法项')
    if (id.includes('/') || id.includes('\\') || id === '.' || id === '..') {
      throw new ApiError('forbidden', `非法会话 id：${id}`, 403)
    }
  }
}

async function safeStatDir(dirPath) {
  try {
    const stat = await fsp.stat(dirPath)
    return stat
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ */
/* agent tools                                                         */
/* ------------------------------------------------------------------ */

function toolOutput(properties) {
  return { type: 'object', properties, required: Object.keys(properties) }
}

function paramSchema(fields) {
  return { type: 'object', properties: fields, required: [] }
}

function sessionManagerListTool(store) {
  return {
    name: 'session_manager_list',
    description:
      '列出 DSH 所有历史会话（含已归档），返回 id、标题目录、更新时间、是否运行中、大小。',
    parameters: paramSchema({}),
    output: toolOutput({
      total: { type: 'number', required: true },
      archivedCount: { type: 'number', required: true },
      sessions: { type: 'array', required: true },
      archived: { type: 'array', required: true },
      text: { type: 'string', required: true },
    }),
    async execute() {
      const state = await store.api.list()
      return {
        total: state.total,
        archivedCount: state.archivedCount,
        sessions: state.sessions.map((s) => ({
          id: s.id,
          cwd: s.cwd,
          updatedAt: s.updatedAt,
          running: s.running,
          sizeBytes: s.sizeBytes,
        })),
        archived: state.archived,
        text: `共 ${state.total} 个会话，${state.archivedCount} 个已归档。`,
      }
    },
  }
}

function sessionManagerArchiveTool(store) {
  return {
    name: 'session_manager_archive',
    description: '归档一批会话（移出列表但保留数据，可恢复）。ids 为会话 id 数组。',
    parameters: paramSchema({
      ids: { type: 'array', required: true, description: '会话 id 数组。' },
    }),
    output: toolOutput({
      results: { type: 'array', required: true },
      text: { type: 'string', required: true },
    }),
    async execute(args) {
      const input = isPlainObject(args) ? args : {}
      try {
        const { results } = await store.api.archive({ ids: input.ids })
        const ok = results.filter((r) => r.ok).length
        return { results, text: `已归档 ${ok} 个会话。` }
      } catch (error) {
        return { results: [], text: `归档失败：${errorMessage(error)}` }
      }
    },
  }
}

function sessionManagerRestoreTool(store) {
  return {
    name: 'session_manager_restore',
    description: '从归档恢复一批会话。ids 为会话 id 数组。',
    parameters: paramSchema({
      ids: { type: 'array', required: true, description: '会话 id 数组。' },
    }),
    output: toolOutput({
      results: { type: 'array', required: true },
      text: { type: 'string', required: true },
    }),
    async execute(args) {
      const input = isPlainObject(args) ? args : {}
      try {
        const { results } = await store.api.restore({ ids: input.ids })
        const ok = results.filter((r) => r.ok).length
        return { results, text: `已恢复 ${ok} 个会话。` }
      } catch (error) {
        return { results: [], text: `恢复失败：${errorMessage(error)}` }
      }
    },
  }
}

function sessionManagerDeleteTool(store) {
  return {
    name: 'session_manager_delete',
    description: '永久删除一批会话（不可恢复）。ids 为会话 id 数组。',
    parameters: paramSchema({
      ids: { type: 'array', required: true, description: '会话 id 数组。' },
    }),
    output: toolOutput({
      results: { type: 'array', required: true },
      text: { type: 'string', required: true },
    }),
    async execute(args) {
      const input = isPlainObject(args) ? args : {}
      try {
        const { results } = await store.api.delete({ ids: input.ids })
        const ok = results.filter((r) => r.ok).length
        return { results, text: `已永久删除 ${ok} 个会话。` }
      } catch (error) {
        return { results: [], text: `删除失败：${errorMessage(error)}` }
      }
    },
  }
}

function createToolDefinitions(store) {
  return [
    sessionManagerListTool(store),
    sessionManagerArchiveTool(store),
    sessionManagerRestoreTool(store),
    sessionManagerDeleteTool(store),
  ]
}

/* ------------------------------------------------------------------ */
/* HTTP route                                                          */
/* ------------------------------------------------------------------ */

function writeJson(res, status, body) {
  try {
    if (res === null || res === undefined || typeof res.writeHead !== 'function') return
    if (res.headersSent === true) {
      safeCall(() => res.destroy?.())
      return
    }
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  } catch {
    safeCall(() => res?.destroy?.())
  }
}

function writeErrorEnvelope(res, error) {
  const status = error instanceof ApiError ? error.status : 500
  const code = error instanceof ApiError ? error.code : 'internal'
  const message = error instanceof ApiError ? error.message : `内部错误：${errorMessage(error)}`
  writeJson(res, status, { ok: false, error: { code, message } })
}

async function readRequestBody(req) {
  const chunks = []
  let total = 0
  const push = (chunk) => {
    const buffer = Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw badRequest('请求体过大')
    chunks.push(buffer)
  }
  if (req !== null && req !== undefined && typeof req[Symbol.asyncIterator] === 'function') {
    for await (const chunk of req) push(chunk)
  } else if (req !== null && req !== undefined && typeof req.on === 'function') {
    await new Promise((resolve, reject) => {
      req.on('data', (chunk) => {
        try {
          push(chunk)
        } catch (error) {
          reject(error)
        }
      })
      req.on('end', resolve)
      req.on('error', reject)
    })
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function readJsonBody(req) {
  const text = await readRequestBody(req)
  if (text.trim() === '') return {}
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw badRequest('请求体不是合法的 JSON')
  }
  return parsed
}

function parseApiMethod(rawUrl) {
  let pathname
  try {
    pathname = new URL(typeof rawUrl === 'string' && rawUrl !== '' ? rawUrl : '/', 'http://dsh.internal').pathname
  } catch {
    return null
  }
  const prefix = `${API_PREFIX}/`
  if (!pathname.startsWith(prefix)) return null
  const rest = pathname.slice(prefix.length).replace(/\/+$/, '')
  if (rest === '' || rest.includes('/')) return null
  try {
    return decodeURIComponent(rest)
  } catch {
    return null
  }
}

function isRequestFenced(ctx, req) {
  try {
    if (ctx.connection === undefined || ctx.connection === null) return true
    if (typeof ctx.connection.requestRejection !== 'function') return true
    return ctx.connection.requestRejection(req) === undefined
  } catch {
    return false
  }
}

function createApiHandler(store, ctx) {
  return async function sessionManagerApiHandler(req, res) {
    try {
      if (!isRequestFenced(ctx, req)) {
        writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        return
      }
      if (req === null || req === undefined || req.method !== 'POST') {
        writeJson(res, 400, { ok: false, error: { code: 'bad-request', message: '仅支持 POST 请求' } })
        return
      }
      const method = parseApiMethod(req.url)
      const handler = method === null ? null : store.api[method]
      if (typeof handler !== 'function') {
        const message = method === null ? '未知的接口方法' : `未知的接口方法：${method}`
        writeJson(res, 404, { ok: false, error: { code: 'not-found', message } })
        return
      }
      let body
      try {
        body = await readJsonBody(req)
      } catch (error) {
        writeErrorEnvelope(res, error)
        return
      }
      const value = await handler(body)
      writeJson(res, 200, { ok: true, value })
    } catch (error) {
      if (error instanceof ApiError) {
        writeErrorEnvelope(res, error)
        return
      }
      logError(ctx, error)
      writeJson(res, 500, { ok: false, error: { code: 'internal', message: `内部错误：${errorMessage(error)}` } })
    }
  }
}

/* ------------------------------------------------------------------ */
/* plugin entry                                                        */
/* ------------------------------------------------------------------ */

/**
 * Cordis plugin entry.
 * @param {object} ctx - plugin context with `tools`, `webServer`, `connection`.
 * @param {object} [config] - unused (all paths derive from DSH_HOME).
 */
export function apply(ctx, config) {
  void config
  const store = createStore(ctx)

  ctx.effect(() => {
    const disposers = []
    for (const tool of createToolDefinitions(store)) {
      try {
        const dispose = ctx.tools.register(tool)
        if (typeof dispose === 'function') disposers.push(dispose)
      } catch (error) {
        logWarn(ctx, `failed to register tool ${tool.name}: ${errorMessage(error)}`)
      }
    }
    return () => {
      for (const dispose of disposers.reverse()) safeCall(dispose)
    }
  }, 'dsh-session-manager: agent tools')

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: createApiHandler(store, ctx),
      }),
    'dsh-session-manager: http api',
  )
}
