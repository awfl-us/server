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
import apiKeysRoutes from './apiKeys/index.js'
import githubAppRoutes from './githubApp/index.js'
import producerRoutes from '../jobs/producer/index.js'
import { createMcpResultsRouter } from '../mcp/results.js'
import filesystemRoutes from './services/filesystem.js'
import llmApiRoutes from './llm.api.js'
import llmUsageRoutes from '../jobs/llm/usage.js';

const router = express.Router()
router.use(express.json())

// Client-facing workflows endpoints (protected by clientAuth)
router.use(clientAuth)

// API keys belong to a user, not a project. Firebase clientAuth still applies.
router.use('/api-keys', apiKeysRoutes)
// GitHub App setup is user/project scoped; it does not rely on x-project-id.
router.use('/github-app', githubAppRoutes)

// Add the projectId middleware after projects
router.use('/projects', projectsRoutes)

router.use(projectIdMiddleware);

// Events relay under /workflows/events (auth via shared clientAuth + SKIP_AUTH support)
router.use('/events', eventsRoutes)
// The shared project consumer posts claimed MCP command results using normal Firebase auth.
router.use('/mcp-tools', createMcpResultsRouter())

router.use('/context', contextRoutes)
router.use('/exec', execRoutes)
router.use('/tasks', createTasksRouter())
router.use('/tools', toolsRoutes)
router.use('/agents', agentsRoutes)
router.use('/definitions', definitionsRoutes)
router.use('/types', typesRoutes)
router.use('/prompts', promptsRoutes)
router.use('/services/git', gitFilesRouter)
router.use('/services/filesystem', filesystemRoutes)
router.use('/workspace', workspaceRoutes)
router.use('/creds', credsRoutes)
router.use('/callbacks', callbacksRoutes)
router.use('/producer', producerRoutes)

// Client-facing LLM info (models list, etc.)
router.use('/llm', llmApiRoutes)
router.use('/llm/usage', llmUsageRoutes);

router.use('/', workflows)

export default router
