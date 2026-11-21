import { randomUUID } from 'node:crypto';
import type { Request, Response, Router } from 'express';
import { AppError, type AuthContext } from '../../common/http.ts';

/**
 * Read-only, in-process access to other modules' HTTP handlers, as the signed-in user.
 *
 * The assistant's lookups do not re-implement queries: they call the very GET handlers the web app
 * uses (search, device detail, incidents, Network Doctor, insights, events, checks, topology), with
 * the user's own AuthContext. So every lookup:
 *   - runs inside that user's tenant transaction (Row Level Security: another organization's rows do not exist),
 *   - passes the same `requireRole` checks as the UI would for that user,
 *   - and can only ever read: the method is always GET, there is no request body, and only
 *     the paths named by tools.ts are ever requested.
 *
 * The request and response objects are minimal stand-ins: only what the read handlers use
 * (params, query, auth, json/send/status) is provided; nothing reaches the network.
 */

type Query = Record<string, string | number | boolean | null | undefined>;

export async function readApi<T>(router: Router, ctx: AuthContext, path: string, query: Query = {}): Promise<T> {
  if (!path.startsWith('/') || path.includes('?') || path.includes('..')) throw new Error(`readApi: invalid path ${path}`);
  const cleanQuery: Record<string, string> = {};
  for (const [k, v] of Object.entries(query)) if (v !== null && v !== undefined && v !== '') cleanQuery[k] = String(v);

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    let status = 200;
    const req = {
      method: 'GET',
      url: path,
      originalUrl: path,
      baseUrl: '',
      path,
      query: cleanQuery,
      params: {},
      headers: {},
      body: undefined,
      auth: { ...ctx },
      id: `assistant-${randomUUID()}`,
      ip: undefined,
      get: () => undefined,
      header: () => undefined,
    } as unknown as Request;
    const done = (body: unknown) =>
      settle(() => {
        if (status >= 400) {
          const err = (body as { error?: { code?: string; message?: string } } | undefined)?.error;
          reject(new AppError(status, err?.code ?? 'http_error', err?.message ?? `Lookup failed (${status})`));
        } else resolve(body as T);
      });
    const res: Record<string, unknown> = {
      statusCode: 200,
      headersSent: false,
      locals: {},
      status(code: number) {
        status = code;
        res.statusCode = code;
        return res;
      },
      json: (body: unknown) => done(body),
      send: (body: unknown) => done(body),
      end: () => done(undefined),
      set: () => res,
      setHeader: () => res,
      type: () => res,
      attachment: () => res,
      getHeader: () => undefined,
    };

    try {
      router(req, res as unknown as Response, (err?: unknown) => settle(() => reject(err ?? new AppError(404, 'not_found', `No read endpoint ${path}`))));
    } catch (err) {
      settle(() => reject(err));
    }
  });
}
