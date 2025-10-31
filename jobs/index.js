import express from 'express';

import businessReportWorkerRoutes from './businessReport/index.js';
import firebaseRoutes from './firebaseDbApi.js';
import llmRoutes from './llm.js';
import loadConvoHistoryRoutes from './loadConvoHistory.js';
import topicContextYojRouter from '../workflows/context/topicContextYoj.js'
import collapseIndexerRouter from '../workflows/context/collapseIndexer.js'
import execJobsRouter from './workflows.exec.js'
import { createTasksRouter } from '../workflows/tasks.js'
import { workflowsUserInject } from './userAuth.js';
// Reuse the client tools service under jobs/ as well
import toolsRoutes from '../workflows/tools/index.js'
import agentsRoutes from '../workflows/agents/index.js'
import eventsRoutes from '../workflows/events/index.js'
import { projectIdMiddleware } from '../workflows/projects/util.js';

const router = express.Router();
router.use(express.json());
router.use(workflowsUserInject);
router.use(projectIdMiddleware);

// Mount individual job routes
router.use('/business-report', businessReportWorkerRoutes);
router.use('/firebase', firebaseRoutes);
router.use('/llm', llmRoutes);
router.use('/convo-history', loadConvoHistoryRoutes);

// Context routes
router.use('/context', topicContextYojRouter);
router.use('/context', collapseIndexerRouter);

// Tools service (same implementation as client-facing)
router.use('/tools', toolsRoutes);

// Workflow-internal exec routes (mounted under /jobs/workflows/exec/*)
router.use('/workflows/exec', execJobsRouter);

// Tasks internal routes (mounted under /jobs/tasks/*)
router.use('/tasks', createTasksRouter());

router.use('/agents', agentsRoutes);

router.use('/events', eventsRoutes)

export default router;
