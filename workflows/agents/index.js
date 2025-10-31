import express from 'express';
import { ensureUserAuth } from './common.js';
import crudRoutes from './agents.crud.js';
import toolRoutes from './agents.tools.js';
import sessionRoutes from './session.map.js';

const router = express.Router();
router.use(express.json());
router.use(ensureUserAuth);

router.use('/', crudRoutes);
router.use('/', toolRoutes);
router.use('/', sessionRoutes);

export default router;
