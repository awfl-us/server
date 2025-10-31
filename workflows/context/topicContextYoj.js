// TopicContextYoj context endpoint (JS server-side)
// Accepts a structured model definition describing which Yoj/Ista components
// to assemble into the final ChatMessage list, mirroring Scala's modular DSL.

import express from 'express';
import { promoteKala, buildYojMessages } from './lib/prakriya.js';
import { decodeContextModel } from './modelDecoder.js';
import { applyFilters } from './filters/index.js';
import { getUserIdFromReq } from '../../jobs/userAuth.js';

const router = express.Router();

async function runUpstream({ name, kala, userId, projectId, framing, includeDocId = false }) {
  const nextKala = promoteKala(kala);
  if (!nextKala) return [];
  const upstreamYoj = await runUpstream({ name, kala: nextKala, userId, projectId, framing, includeDocId });
  const promotedYoj = await buildYojMessages({ name, kala: nextKala, userId, projectId, framing, includeDocId });
  return [...upstreamYoj, ...promotedYoj];
}

async function buildComponentMessages({ component, kala, userId, projectId, includeDocId = false }) {
  const { kind } = component;
  if (kind === 'yoj') {
    const { name, framing = '' } = component;
    return await buildYojMessages({ name, kala, userId, projectId, framing, includeDocId });
  }
  if (kind === 'ista') {
    // For now, treat Ista like Yoj reads (same storage structure), if needed we can
    // add separate pathing later.
    const { name, framing = '' } = component;
    return await buildYojMessages({ name, kala, userId, projectId, framing, includeDocId });
  }
  if (kind === 'literal') {
    const { value } = component;
    return [{ role: 'system', content: value }];
  }
  return [];
}

function extractSessionId(kala) {
  if (!kala || !kala.kind) return undefined;
  if (kala.kind === 'SegKala' && kala.sessionId) return kala.sessionId;
  if (kala.kind === 'SessionKala' && kala.sessionId) return kala.sessionId;
  return undefined;
}

// Flatten components by depth-first, left-to-right order. Only leaf nodes produce output.
function flattenComponents(components = []) {
  const out = [];
  const visit = (c) => {
    const children = Array.isArray(c?.children) ? c.children : undefined;
    if (children && children.length > 0) {
      for (const child of children) visit(child);
    } else {
      out.push(c);
    }
  };
  for (const c of components) visit(c);
  return out;
}

router.post('/topicContextYoj/run', async (req, res) => {
  try {
    // Prefer explicit userId for jobs endpoints, then fall back to token-based extraction
    const hintedUserId = req?.body?.userId || req?.query?.userId || req?.headers?.['x-user-id'] || req?.userId;
    const userId = hintedUserId ? String(hintedUserId) : (await getUserIdFromReq(req));
    if (!userId) return res.status(401).json({ error: 'Unauthorized: missing or invalid user token' });

    const projectId = req.projectId;

    const { kala, model } = decodeContextModel(req.body || {});

    // New optional flag: include document IDs alongside returned messages
    const includeDocId = Boolean(req?.body?.includeDocId);

    const messages = [];

    // Optional intro
    if (model.intro?.system) {
      messages.push({ role: 'system', content: model.intro.system });
    }

    // Flatten components (DFS, left-to-right). Only leaves are rendered.
    const leaves = flattenComponents(model.components);

    for (const component of leaves) {
      if (model.promoteUpstream && (component.kind === 'yoj' || component.kind === 'ista')) {
        // Include upstream context for promoted Kala(s)
        const upstream = await runUpstream({ name: component.name, kala, userId, projectId, framing: component.framing || '', includeDocId });
        messages.push(...upstream);
      }

      const local = await buildComponentMessages({ component, kala, userId, projectId, includeDocId });
      messages.push(...local);
    }

    // Build filters (defaults handled in modelDecoder; fallback kept in sync with AGENT.md)
    const pipeline = model.filters;

    const ctx = { sessionId: extractSessionId(kala), userId, projectId };

    // Apply filter pipeline (note: now async to support Firestore lookups)
    const filtered = await applyFilters(
      messages,
      pipeline,
      ctx,
    );

    return res.status(200).json({ yoj: filtered });
  } catch (err) {
    console.error('Error in /context/topicContextYoj/run:', err);
    return res.status(400).json({ error: err?.message || 'Failed to run TopicContextYoj' });
  }
});

export default router;
