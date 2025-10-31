import express from 'express';
import tree from './tree.js';
import stop from './stop.js';
import status from './status.js';

const router = express.Router();

router.use(tree);
router.use(stop);
router.use(status);

export default router;
