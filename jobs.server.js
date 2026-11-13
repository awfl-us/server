import express from 'express'
import jobsRoutes from './jobs/index.js'
import { startNativeDetachedRecovery } from './jobs/native.js'

const app = express()
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
app.use('/jobs', jobsRoutes)
app.use('/', jobsRoutes)

// 404 fallback
app.use((req, res) => {
  res.status(404).send('Not Found')
})

const PORT = process.env.PORT || 8080
// The authenticated local Jobs test server should bind only to loopback.
// Production keeps the default all-interface bind unless explicitly set.
const HOST = process.env.AWFL_JOBS_BIND_HOST || '0.0.0.0'
app.listen(PORT, HOST, () => {
  console.log(`Jobs service listening on port ${PORT}`)
  startNativeDetachedRecovery()
})
