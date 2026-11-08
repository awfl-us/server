import consumerCredentialRefresh from './workflows/googleCloud/consumerRefresh.js';
import express from 'express'
import workflowsRoutes from './workflows/index.js'
import { getFirestore } from 'firebase-admin/firestore'
import { ExecutionService } from './mcp/service.js'
import { createMcpRouter } from './mcp/index.js'
import { githubAppCallback } from './workflows/githubApp/index.js'
import { googleCloudCallback } from './workflows/googleCloud/index.js'

const app = express()
app.use(express.json({ limit: '1mb' }))

// --- CORS for prod (api.awfl.us) ---
// Supports:
// - Single origin via CORS_ALLOW_ORIGIN (e.g., https://awfl.us)
// - Comma/space-separated list of origins
// - Automatic inclusion of the www/base variant for root domains (e.g., awfl.us <-> www.awfl.us)
const RAW_ALLOWED_ORIGIN = process.env.CORS_ALLOW_ORIGIN || 'https://awfl.us'
const ALLOWED_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS'
const ALLOWED_HEADERS = 'Authorization, Content-Type, x-project-id, x-consumer-id'
const MAX_AGE = process.env.CORS_MAX_AGE || '600'
const ALLOW_CREDENTIALS = process.env.CORS_ALLOW_CREDENTIALS === 'true'

function normalizeAndExpandOrigins(raw) {
  // Accept comma or whitespace separated list
  const parts = raw.split(/[\s,]+/).map(s => s.trim()).filter(Boolean)
  const set = new Set()

  for (const part of parts) {
    if (part === '*') {
      // Wildcard means reflect the request Origin (compatible with credentials)
      set.clear()
      set.add('*')
      break
    }
    try {
      const u = new URL(part)
      // Always store normalized origin (no trailing slash, scheme+host+port)
      const origin = u.origin
      set.add(origin)

      // If https and a root domain like awfl.us, also allow https://www.<root>
      // If https and host starts with www., also allow the base root domain.
      if (u.protocol === 'https:') {
        const host = u.hostname
        const dotCount = (host.match(/\./g) || []).length
        if (host.startsWith('www.')) {
          const baseHost = host.slice(4)
          if (baseHost) {
            const u2 = new URL(origin)
            u2.hostname = baseHost
            set.add(u2.origin)
          }
        } else if (dotCount === 1) {
          // Looks like a root domain (e.g., awfl.us), add www variant
          const u2 = new URL(origin)
          u2.hostname = `www.${host}`
          set.add(u2.origin)
        }
      }
    } catch {
      // Not a URL — keep as-is for back-compat (unlikely for CORS origins)
      set.add(part)
    }
  }

  return Array.from(set)
}

const ALLOWED_ORIGINS = normalizeAndExpandOrigins(RAW_ALLOWED_ORIGIN)

const cors = (req, res, next) => {
  const origin = req.headers.origin
  // Ensure caching layers vary on Origin
  res.setHeader('Vary', 'Origin')

  // Reflect the request origin if allowed
  if (origin) {
    if (ALLOWED_ORIGINS.includes('*')) {
      res.setHeader('Access-Control-Allow-Origin', origin)
    } else if (ALLOWED_ORIGINS.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
    }
  }
  if (ALLOW_CREDENTIALS) {
    res.setHeader('Access-Control-Allow-Credentials', 'true')
  }

  if (req.method === 'OPTIONS') {
    // Preflight response
    res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS)
    res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS)
    res.setHeader('Access-Control-Max-Age', MAX_AGE)
    return res.status(204).end()
  }

  return next()
}
app.use(cors)

const logging = (req, _res, next) => {
  const { method, path } = req
  // Do not log OAuth codes, state, or other query-string credentials.
  if (!path.includes('health')) {
    console.log(`[API] ${method} ${path}`)
  }
  next()
}
app.use(logging)

// Health checks (support both /health and /api/health for compatibility)
app.get('/health', (_req, res) => res.status(200).send('OK'))
// GitHub OAuth redirects cannot carry the Firebase Authorization header.
// Binding is secured by the authenticated, single-use state created at /workflows/github-app/start.
app.get('/github-app/callback', githubAppCallback)
app.get('/google-cloud/callback', googleCloudCallback)

// MCP tool calls use an API key; consumer results use the regular Firebase-authenticated workflows API.
const execution = new ExecutionService({ db: getFirestore() })
app.use('/mcp', createMcpRouter(execution))

// Workflows (primary mount)
app.use('/consumer-credentials/refresh', consumerCredentialRefresh)
app.use('/workflows', workflowsRoutes)
// Back-compat for local/dev prefix
// app.use('/api/workflows', workflowsRoutes)

// 404 fallback
app.use((req, res) => {
  res.status(404).send('Not Found')
})

const PORT = process.env.PORT || 8080
app.listen(PORT, () => {
  console.log(`API service listening on port ${PORT}`)
  console.log(`[API] CORS allowlist (normalized): ${ALLOWED_ORIGINS.join(', ')}`)
})
