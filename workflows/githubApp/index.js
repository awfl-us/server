import express from 'express';
import { beginGithubAppOAuth, disconnectGithubApp, finishGithubAppOAuth, getGithubAppStatus } from './service.js';

const router = express.Router();
router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
const projectId = req => req.body?.projectId || req.query?.projectId;

router.get('/status', async (req, res) => {
  try {
    if (!req.userId) return res.sendStatus(401);
    res.json(await getGithubAppStatus({ userId: req.userId, projectId: projectId(req) }));
  } catch (error) {
    res.status(error.message === 'Project not found' ? 404 : 400).json({ error: error.message });
  }
});
router.post('/start', async (req, res) => {
  try {
    if (!req.userId) return res.sendStatus(401);
    res.json(await beginGithubAppOAuth({ userId: req.userId, projectId: projectId(req) }));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});
router.post('/disconnect', async (req, res) => {
  try {
    if (!req.userId) return res.sendStatus(401);
    res.json(await disconnectGithubApp({ userId: req.userId, projectId: projectId(req) }));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});
export default router;

export async function githubAppCallback(req, res) {
  res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer');
  try {
    const { projectId, result } = await finishGithubAppOAuth({
      state: req.query?.state, code: req.query?.code,
    });
    const origin = process.env.GITHUB_APP_WEB_ORIGIN || 'https://awfl.us';
    const url = new URL('/', origin);
    url.searchParams.set('github_app', result);
    url.searchParams.set('project_id', projectId);
    return res.redirect(303, url.toString());
  } catch (error) {
    console.warn('[github-app] callback unsuccessful', error?.name || 'Error');
    return res.status(400).type('text/plain').send('GitHub authorization could not be completed. Return to AWFL and retry.');
  }
}
