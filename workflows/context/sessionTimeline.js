import express from 'express';
import { getDocumentStorage } from '../../storage/service.js';
import { readSessionTimeline, TimelineError } from './lib/sessionTimeline.js';

// Mounted only under clientAuth + projectIdMiddleware, not the jobs router.
export function createSessionTimelineRouter({ getStorage = getDocumentStorage } = {}) {
  const router = express.Router();
  router.post('/sessions/timeline', async (req, res) => {
    res.set('Cache-Control','no-store');
    if (!req.userId) return res.status(401).json({error:'Unauthorized'});
    try {
      const {sessionId,limit,before,after} = req.body ?? {};
      const storage = await getStorage();
      const page = await readSessionTimeline(storage,{userId:req.userId,projectId:req.projectId,sessionId,limit,before,after});
      return res.json(page);
    } catch (error) {
      if (error instanceof TimelineError) return res.status(error.status).json({error:error.message});
      console.error('[session-timeline] read failed',error?.name || 'Error');
      return res.status(503).json({error:'Session timeline unavailable'});
    }
  });
  return router;
}
