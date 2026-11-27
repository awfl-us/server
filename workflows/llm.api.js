import express from 'express'
import { modelCatalog } from '../jobs/llm/modelCatalog.js'

const router = express.Router()
router.get('/models', (_req, res) => res.status(200).json(modelCatalog()))
export default router
