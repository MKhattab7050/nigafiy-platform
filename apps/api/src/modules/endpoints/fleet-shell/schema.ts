import { z } from 'zod';

/** POST /endpoints/:id/shell: open a remote shell (admins; the group must allow it). */
export const shellOpenSchema = z
  .object({
    reason: z.string().trim().min(3).max(200),
    profile_id: z.uuid().optional(),
    step_up_token: z.string().max(200).optional(),
    cols: z.number().int().min(20).max(400).default(120),
    rows: z.number().int().min(5).max(200).default(30),
  })
  .strict();
export type ShellOpen = z.infer<typeof shellOpenSchema>;

export const shellParams = z.object({ id: z.uuid(), shellId: z.uuid() });

export const shellListQuery = z
  .object({
    endpoint_id: z.uuid().optional(),
    state: z.enum(['opening', 'open', 'closed']).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

/** Operator socket text messages (binary messages are keystrokes). */
export const shellOperatorMessage = z.discriminatedUnion('t', [
  z.object({ t: z.literal('resize'), cols: z.number().int().min(20).max(400), rows: z.number().int().min(5).max(200) }).strict(),
  z.object({ t: z.literal('ping') }).strict(),
]);

/** Agent socket text messages (binary messages are the shell's output). */
export const shellAgentMessage = z.discriminatedUnion('t', [
  z
    .object({
      t: z.literal('hello'),
      shell: z.string().max(200),
      pty: z.enum(['conpty', 'pty', 'pipes']),
      cols: z.number().int().optional(),
      rows: z.number().int().optional(),
    })
    .strict(),
  z.object({ t: z.literal('exit'), code: z.number().int().nullable() }).strict(),
  z.object({ t: z.literal('error'), error: z.string().max(500) }).strict(),
]);

/** POST /api/v1/agent/shell-end: the shell ended on the computer (End on the banner, exit, idle, limit). */
export const agentShellEndSchema = z
  .object({
    shell_id: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
    reason: z.enum(['user', 'exited', 'idle', 'limit', 'agent_gone']),
    exit_code: z.number().int().nullable().optional(),
  })
  .strict();
