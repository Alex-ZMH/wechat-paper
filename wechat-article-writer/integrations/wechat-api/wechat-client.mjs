import { readFile } from 'node:fs/promises'

const apiRoot = 'https://api.weixin.qq.com'

async function loadLocalEnv() {
  try {
    const raw = await readFile(new URL('./.env', import.meta.url), 'utf8')
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/)
      if (!match || process.env[match[1]]) continue
      const value = match[2].replace(/^(['"])(.*)\1$/, '$2')
      process.env[match[1]] = value
    }
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return
    throw new Error('Unable to read local credential configuration.')
  }
}

await loadLocalEnv()

function apiError(payload, fallback) {
  const code = typeof payload?.errcode === 'number' ? payload.errcode : fallback
  const message = typeof payload?.errmsg === 'string' ? payload.errmsg : 'Unexpected response from the WeChat API'
  return new Error(`WeChat API error: ${code} ${message}`)
}

async function readJson(response) {
  const payload = await response.json().catch(() => null)
  if (!response.ok || payload?.errcode) {
    throw apiError(payload, `HTTP ${response.status}`)
  }
  return payload
}

export async function getAccessToken() {
  const appId = process.env.WECHAT_APP_ID?.trim()
  const appSecret = process.env.WECHAT_APP_SECRET?.trim()
  if (!appId || !appSecret) {
    throw new Error('Missing WECHAT_APP_ID or WECHAT_APP_SECRET. Set them as local environment variables.')
  }

  const url = new URL('/cgi-bin/token', apiRoot)
  url.searchParams.set('grant_type', 'client_credential')
  url.searchParams.set('appid', appId)
  url.searchParams.set('secret', appSecret)
  const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) })
  const payload = await readJson(response)
  if (typeof payload.access_token !== 'string' || !payload.access_token) {
    throw apiError(payload, 'missing access_token')
  }
  return payload.access_token
}

export async function wechatPost(pathname, token, body) {
  const url = new URL(pathname, apiRoot)
  url.searchParams.set('access_token', token)
  const response = await fetch(url, {
    method: 'POST',
    body,
    signal: AbortSignal.timeout(30_000),
  })
  return readJson(response)
}

export function fail(error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
