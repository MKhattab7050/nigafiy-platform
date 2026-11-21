import { Router } from 'express';
import { auth, idParams, parse, requireRole } from '../../common/http.ts';
import { askSchema, explainSchema, settingsPatchSchema, testKeySchema } from './schema.ts';
import { ask, assistantStatus, deleteConversation, explain, getConversation, listConversations, testKey } from './service.ts';
import { loadSettings, presentSettings, updateSettings } from './settings.ts';
import { withTenant } from '../../infrastructure/db.ts';

export const assistantRouter: Router = Router();

/** Any member: is the assistant available, and how much of the budget is used. Drives showing or hiding every assistant button. */
assistantRouter.get('/assistant/status', async (req, res) => {
  res.json(await assistantStatus(auth(req)));
});

// ── configuration: administrators only ──

assistantRouter.get('/assistant/settings', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  res.json(presentSettings(await withTenant(ctx.organizationId, (db) => loadSettings(db))));
});

assistantRouter.put('/assistant/settings', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  res.json(await updateSettings(req, ctx, parse(settingsPatchSchema, req.body)));
});

assistantRouter.post('/assistant/settings/test', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  res.json(await testKey(req, ctx, parse(testKeySchema, req.body ?? {})));
});

// ── asking: any member; lookups run with the member's own role ──

assistantRouter.post('/assistant/ask', async (req, res) => {
  const ctx = auth(req);
  res.json(await ask(req, ctx, parse(askSchema, req.body)));
});

assistantRouter.post('/assistant/explain', async (req, res) => {
  const ctx = auth(req);
  res.json(await explain(req, ctx, parse(explainSchema, req.body)));
});

// ── transcripts: only the person who asked, whatever their role ──

assistantRouter.get('/assistant/conversations', async (req, res) => {
  res.json(await listConversations(auth(req)));
});

assistantRouter.get('/assistant/conversations/:id', async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  res.json(await getConversation(ctx, id));
});

assistantRouter.delete('/assistant/conversations/:id', async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  await deleteConversation(req, ctx, id);
  res.status(204).end();
});
