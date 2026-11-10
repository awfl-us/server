import express from 'express'
import jobsRoutes from './jobs/index.js'
import { getFirestore } from 'firebase-admin/firestore'
import { ExecutionService } from './mcp/service.js'
import { createDevGateway } from './devGateway/index.js'

const app = express()
// Dev Workflows use this jobs service (not the client API). Mount the gateway
// before JSON parsing to preserve unmodified HTTP bodies and UI assets.
// The feature remains off until the end-to-end security/network test passes.
if (process.env.AWFL_DEV_GATEWAY_ENABLED === 'true') {
  const db = getFirestore()
  const execution = new ExecutionService({ db })
  const gateway = createDevGateway({ db, isOwner: uid => execution.isOwner(uid), mode: 'workflow' })
  app.use('/dev', gateway.proxyRouter)
  app.use('/dev-access', express.json({ limit: '16kb' }), gateway.accessRouter)
}
app.use(express.json({ limit: '1mb' }))

const logging = (req, _res, next) => {
  const { method, url } = req
  if (!url.includes('health')) {
    console.log(`[JOBS] ${method} ${url}`)
  }
  next()
}
app.use(logging)

// Health checks
app.get('/health', (_req, res) => res.status(200).send('OK'))
// app.get('/jobs/health', (_req, res) => res.status(200).send('OK'))

// Mount under both root and /jobs for compatibility
app.use('/', jobsRoutes)
// app.use('/jobs', jobsRoutes)

// 404 fallback
app.use((req, res) => {
  res.status(404).send('Not Found')
})

const PORT = process.env.PORT || 8080
app.listen(PORT, () => {
  console.log(`Jobs service listening on port ${PORT}`)
})
