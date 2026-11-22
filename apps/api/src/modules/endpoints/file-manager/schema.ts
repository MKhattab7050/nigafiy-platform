import { z } from 'zod';

/**
 * Remote File Manager operations. They travel as `fs_op` commands through
 * POST /endpoints/:id/commands (there is no separate route); the agent enforces the endpoint's
 * allowed roots, which the command service attaches from the endpoint policy.
 */
export const fsOpCommandSchema = z
  .object({
    kind: z.literal('fs_op'),
    op: z.enum(['roots', 'list', 'search', 'mkdir', 'touch', 'rename', 'copy', 'move', 'delete', 'download', 'upload']),
    path: z.string().max(1024).optional(),
    paths: z.array(z.string().max(1024)).max(100).optional(),
    target_path: z.string().max(1024).optional(),
    new_name: z.string().max(255).optional(),
    query: z.string().max(200).optional(),
    show_hidden: z.boolean().optional(),
    confirm_destructive: z.boolean().optional(),
    offset: z.number().int().min(0).optional(),
    length: z.number().int().min(1).max(524_288).optional(),
    append: z.boolean().optional(),
    data_base64: z.string().max(1_500_000).optional(),
    expected_sha256: z.string().max(64).optional(),
    /** Upload only: replace an existing file. The console sets it only after the operator confirms in a dialog. */
    overwrite: z.boolean().optional(),
  })
  .strict();
export type FsOpCommand = z.infer<typeof fsOpCommandSchema>;
