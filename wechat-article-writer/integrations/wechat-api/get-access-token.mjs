/**
 * Minimal, local-only WeChat Official Account credential check.
 *
 * Usage (PowerShell):
 *   $env:WECHAT_APP_ID='...'
 *   $env:WECHAT_APP_SECRET='...'
 *   node get-access-token.mjs
 *
 * This intentionally never prints or writes the access token. It only reports
 * whether the configured credentials were accepted by the API.
 */

import { getAccessToken } from './wechat-client.mjs'

try {
  await getAccessToken()
  console.log('Credential check passed. Access token received without printing or storing it.')
} catch (error) {
  console.error(`Credential check failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
