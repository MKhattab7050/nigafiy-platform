import type { FleetScriptParam } from '@nigafiy/shared-types';
import { z } from 'zod';
import { AppError } from '../../../common/http.ts';

// Typed script parameters (Fleet Pro scripts library). A script version declares its parameters;
// a job gives values, which are checked here against the declaration and then travel to the agent
// as typed data ({name, type, value}). The agent passes them to PowerShell by splatting a hashtable
// built from environment variables (param block binding) and to /bin/sh as environment variables:
// a value is never pasted into the script's text, so quotes, $(...), backticks or ; in a value are
// just characters (agents/endpoint-agent/internal/scripts, pinned by tests on both sides).

/** A parameter name is also a PowerShell variable and part of an environment variable name. */
export const PARAM_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
/** Names PowerShell or the runner itself uses: a parameter with one of these would be confusing or unsafe. */
const RESERVED = new Set(['args', 'input', 'this', 'true', 'false', 'null', 'error', 'home', 'host', 'pid', 'pwd', 'profile', 'psitem', 'shellid', 'env', 'nigafiy']);

export const MAX_PARAMS = 20;
export const MAX_STRING_VALUE = 4000;

const choiceValue = z.string().trim().min(1).max(200);

export const scriptParamSchema = z
  .object({
    name: z
      .string()
      .trim()
      .regex(PARAM_NAME, 'A parameter name starts with a letter and has only letters, digits and _ (at most 40)')
      .refine((n) => !RESERVED.has(n.toLowerCase()), 'This parameter name is reserved'),
    type: z.enum(['string', 'int', 'bool', 'choice']),
    label: z.string().trim().max(120).nullable().default(null),
    required: z.boolean().default(false),
    default: z.union([z.string().max(MAX_STRING_VALUE), z.number().int(), z.boolean()]).nullable().default(null),
    choices: z.array(choiceValue).min(1).max(50).nullable().default(null),
    min: z.number().int().min(-2_147_483_648).max(2_147_483_647).nullable().default(null),
    max: z.number().int().min(-2_147_483_648).max(2_147_483_647).nullable().default(null),
    max_length: z.number().int().min(1).max(MAX_STRING_VALUE).nullable().default(null),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.type === 'choice' && !p.choices?.length) ctx.addIssue({ code: 'custom', message: `${p.name}: a choice parameter needs its choices` });
    if (p.type !== 'choice' && p.choices) ctx.addIssue({ code: 'custom', message: `${p.name}: only a choice parameter has choices` });
    if (p.type !== 'int' && (p.min !== null || p.max !== null)) ctx.addIssue({ code: 'custom', message: `${p.name}: only a number has a minimum and maximum` });
    if (p.min !== null && p.max !== null && p.min > p.max) ctx.addIssue({ code: 'custom', message: `${p.name}: the minimum is above the maximum` });
    if (p.type !== 'string' && p.max_length !== null) ctx.addIssue({ code: 'custom', message: `${p.name}: only text has a maximum length` });
    if (p.default !== null) {
      const err = valueError(p as FleetScriptParam, p.default);
      if (err) ctx.addIssue({ code: 'custom', message: `${p.name}: the default ${err}` });
    }
  });

export const scriptParamsSchema = z
  .array(scriptParamSchema)
  .max(MAX_PARAMS)
  .superRefine((list, ctx) => {
    const seen = new Set<string>();
    for (const p of list) {
      // PowerShell parameter names are case-insensitive, so are environment variables on Windows.
      const k = p.name.toLowerCase();
      if (seen.has(k)) ctx.addIssue({ code: 'custom', message: `Two parameters are named ${p.name}` });
      seen.add(k);
    }
  });

export type ParamValue = string | number | boolean;

/** Why a value does not fit its parameter (null: it fits). */
export function valueError(p: FleetScriptParam, v: unknown): string | null {
  switch (p.type) {
    case 'string':
      if (typeof v !== 'string') return 'must be text';
      if (v.includes('\0')) return 'must not contain a NUL character';
      if (v.length > (p.max_length ?? MAX_STRING_VALUE)) return `is longer than ${p.max_length ?? MAX_STRING_VALUE} characters`;
      return null;
    case 'int':
      if (typeof v !== 'number' || !Number.isInteger(v)) return 'must be a whole number';
      if (v < -2_147_483_648 || v > 2_147_483_647) return 'is out of range';
      if (p.min !== null && v < p.min) return `must be at least ${p.min}`;
      if (p.max !== null && v > p.max) return `must be at most ${p.max}`;
      return null;
    case 'bool':
      return typeof v === 'boolean' ? null : 'must be true or false';
    case 'choice':
      return typeof v === 'string' && (p.choices ?? []).includes(v) ? null : `must be one of: ${(p.choices ?? []).join(', ')}`;
  }
}

/**
 * The values a job runs with: every given value is checked against its declaration, unknown names
 * are refused, defaults fill the gaps, and a required parameter without a value is refused.
 */
export function resolveParamValues(declared: FleetScriptParam[], given: Record<string, unknown>): Record<string, ParamValue> {
  const byName = new Map(declared.map((p) => [p.name, p]));
  const problems: string[] = [];
  for (const k of Object.keys(given)) {
    if (!byName.has(k)) problems.push(`${k}: the script has no such parameter`);
  }
  const out: Record<string, ParamValue> = {};
  for (const p of declared) {
    const v = Object.hasOwn(given, p.name) ? given[p.name] : null;
    if (v === null || v === undefined || (p.type === 'string' && v === '' && p.required)) {
      if (p.default !== null) out[p.name] = p.default;
      else if (p.required) problems.push(`${p.name}: a value is required`);
      continue;
    }
    const err = valueError(p, v);
    if (err) problems.push(`${p.name} ${err}`);
    else out[p.name] = v as ParamValue;
  }
  if (problems.length) throw new AppError(422, 'invalid_parameters', `Parameters: ${problems.join('; ')}`, { problems });
  return out;
}

/** What the agent gets: the declared order, each with its type (the agent converts by type, never by guessing). */
export function agentParams(declared: FleetScriptParam[], values: Record<string, ParamValue>): Array<{ name: string; type: FleetScriptParam['type']; value: string }> {
  const out: Array<{ name: string; type: FleetScriptParam['type']; value: string }> = [];
  for (const p of declared) {
    if (!Object.hasOwn(values, p.name)) continue;
    const v = values[p.name]!;
    out.push({ name: p.name, type: p.type, value: typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v) });
  }
  return out;
}
