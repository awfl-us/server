// Resolve a private owner at deployment; never enable execution for arbitrary API-key holders.
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { appendFileSync } from 'node:fs';
initializeApp();
let owner = process.env.MCP_OWNER_UID;
if (!owner) {
  const records = await getFirestore().collection('apiKeys').get();
  const users = new Set(records.docs.map(d => d.data()).filter(k => k.expiresAt > Date.now()).map(k => k.userId));
  if (users.size !== 1) throw new Error('Set repository variable MCP_OWNER_UID: cannot unambiguously identify the existing private API-key owner');
  owner = [...users][0];
}
if (typeof owner !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(owner)) throw new Error('Invalid owner UID');
appendFileSync(process.env.GITHUB_ENV, `MCP_OWNER_UID=${owner}\n`);
console.log('Private MCP owner configured; UID and API keys omitted from logs.');
