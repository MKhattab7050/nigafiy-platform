import { Router } from 'express';
import { auth, idParams, parse, requireRole } from '../../common/http.ts';
import { createRecord, historyQuery, patchRecord, subnetBody, subnetDetailQuery, subnetListQuery } from './schema.ts';
import {
  addressHistory,
  documentAddress,
  documentSubnet,
  getSubnet,
  listSubnets,
  removeAddress,
  subnetCsv,
  updateAddress,
} from './service.ts';

export const ipamRouter: Router = Router();

// ── subnets ─────────────────────────────────────────────────────────────────

ipamRouter.get('/ipam/subnets', async (req, res) => {
  const ctx = auth(req);
  const { site_id } = parse(subnetListQuery, req.query);
  res.json({ items: await listSubnets(ctx.organizationId, site_id) });
});

ipamRouter.get('/ipam/subnets/:id', async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const page = parse(subnetDetailQuery, req.query);
  res.json(await getSubnet(ctx.organizationId, id, page));
});

ipamRouter.put('/ipam/subnets/:id', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const body = parse(subnetBody, req.body);
  res.json(await documentSubnet(req, ctx, id, body));
});

// CSV of every observed or documented address of the subnet.
ipamRouter.get('/ipam/subnets/:id/export.csv', async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const subnet = await getSubnet(ctx.organizationId, id, 'all');
  const csv = subnetCsv(subnet);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  // IPv6 colons are not allowed in Windows file names.
  res.setHeader('Content-Disposition', `attachment; filename="ipam-${subnet.cidr.replace('/', '_').replaceAll(':', '-')}.csv"`);
  res.send(csv);
});

// ── documented addresses ────────────────────────────────────────────────────

ipamRouter.post('/ipam/addresses', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const body = parse(createRecord, req.body);
  res.status(201).json(await documentAddress(req, ctx, body));
});

ipamRouter.patch('/ipam/addresses/:id', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  const body = parse(patchRecord, req.body);
  res.json(await updateAddress(req, ctx, id, body));
});

ipamRouter.delete('/ipam/addresses/:id', requireRole('technician'), async (req, res) => {
  const ctx = auth(req);
  const { id } = parse(idParams, req.params);
  await removeAddress(req, ctx, id);
  res.status(204).end();
});

// ── who has held this address? ──────────────────────────────────────────────

ipamRouter.get('/ipam/history', async (req, res) => {
  const ctx = auth(req);
  const q = parse(historyQuery, req.query);
  res.json({ items: await addressHistory(ctx.organizationId, q.site_id, q.ip) });
});
