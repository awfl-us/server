import express from 'express';
import {
  beginGoogleCloudOAuth, disconnectGoogleCloud, finishGoogleCloudOAuth,
  googleCloudStatus, testGoogleCloud,
} from './service.js';

const router = express.Router();
router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
const projectId = req => req.body?.projectId || req.query?.projectId;

router.get('/status', async (req, res) => {
  try {
    if (!req.userId) return res.sendStatus(401);
    res.json(await googleCloudStatus({ userId: req.userId, projectId: projectId(req) }));
  } catch (error) {
    res.status(error.message === 'Project not found' ? 404 : 400).json({ error: error.message });
  }
});

router.post('/start', async (req, res) => {
  try {
    if (!req.userId) return res.sendStatus(401);
    res.json(await beginGoogleCloudOAuth({
      userId: req.userId,
      projectId: projectId(req),
      cloudProjectId: req.body?.cloudProjectId,
    }));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.post('/test', async (req, res) => {
  try {
    if (!req.userId) return res.sendStatus(401);
    res.json(await testGoogleCloud({ userId: req.userId, projectId: projectId(req) }));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.post('/disconnect', async (req, res) => {
  try {
    if (!req.userId) return res.sendStatus(401);
    res.json(await disconnectGoogleCloud({ userId: req.userId, projectId: projectId(req) }));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

export default router;

// OAuth callbacks cannot carry Firebase bearer headers. The signed-in user and
// project are bound by the one-time, expiring, server-side OAuth state.
export async function googleCloudCallback(req, res) {
  res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer');
  try {
    const { projectId, result } = await finishGoogleCloudOAuth({
      state: req.query?.state, code: req.query?.code, error: req.query?.error,
    });
    const origin = process.env.GOOGLE_CLOUD_OAUTH_WEB_ORIGIN || 'https://awfl.us';
    const url = new URL('/', origin);
    url.searchParams.set('google_cloud', result);
    url.searchParams.set('project_id', projectId);
    return res.redirect(303, url.toString());
  } catch (error) {
    console.warn('[google-cloud] OAuth callback unsuccessful', error?.name || 'Error');
    return res.status(400).type('text/plain').send('Google Cloud authorization could not be completed. Return to AWFL and retry.');
  }
}
