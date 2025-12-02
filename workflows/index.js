import express from 'express'
import contextRoutes from './context.api.js'
import execRoutes from './exec.api.js'
import { createTasksRouter } from './tasks.js'
import toolsRoutes from './tools/index.js'
import agentsRoutes from './agents/index.js'
import definitionsRoutes from './definitions.crud.js'
import typesRoutes from './types.crud.js'
import promptsRoutes from './prompts/index.js'
import { clientAuth } from './userAuth.js'
import workflows from './workflows.js'
import eventsRoutes from './events/index.js'
import workspaceRoutes from './workspace/index.js'
import projectsRoutes from './projects/index.js'
import { projectIdMiddleware } from './projects/util.js'
import gitFilesRouter from './gitFiles.js';
import callbacksRoutes from './callbacks/index.js'
import credsRoutes from './creds/index.js'
import producerRoutes from '../jobs/producer/index.js'

const router = express.Router()
router.use(express.json())

// Client-facing workflows endpoints (protected by clientAuth)
router.use(clientAuth)

// Add the projectId middleware after projects
router.use('/projects', projectsRoutes)

router.use(projectIdMiddleware);

// Events relay under /workflows/events (auth via shared clientAuth + SKIP_AUTH support)
router.use('/events', eventsRoutes)

router.use('/context', contextRoutes)
router.use('/exec', execRoutes)
router.use('/tasks', createTasksRouter())
router.use('/tools', toolsRoutes)
router.use('/agents', agentsRoutes)
router.use('/definitions', definitionsRoutes)
router.use('/types', typesRoutes)
router.use('/prompts', promptsRoutes)
router.use('/services/git', gitFilesRouter)
router.use('/workspace', workspaceRoutes)
router.use('/creds', credsRoutes)
router.use('/callbacks', callbacksRoutes)
router.use('/producer', producerRoutes)

router.use('/', workflows)

export default router
