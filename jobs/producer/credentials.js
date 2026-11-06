import { resolveGithubCredential } from '../../workflows/gitFiles.js';
import { mintUserTokens } from './auth/firebaseTokens.js';

// Shared by the normal cloud consumer and the MCP consumer. Fetch credentials
// server-side, for the authenticated user and optionally a selected project.
export async function loadConsumerCredentials({ userId, projectId }) {
  let githubToken = null;
  try {
    githubToken = await resolveGithubCredential({ userId, projectId });
  } catch (error) {
    console.warn('[producer] GitHub credential lookup unavailable', error?.name || 'Error');
  }

  let firebaseIdToken = '';
  let firebaseCustomToken = '';
  try {
    const minted = await mintUserTokens({ uid: userId });
    firebaseIdToken = minted?.idToken || '';
    firebaseCustomToken = minted?.customToken || '';
  } catch (error) {
    console.warn('[producer] could not mint user tokens', error?.name || 'Error');
  }
  return { githubToken, firebaseIdToken, firebaseCustomToken };
}
