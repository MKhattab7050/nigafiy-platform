import { z } from 'zod';

/**
 * Remote File Manager operations. They travel as `fs_op` commands through
 * POST /endpoints/:id/commands (there is no separate route); the agent enforces the endpoint's
 * allowed roots, which the command service attaches from the endpoint policy.
 */
export const fsOpCommandSchema = z
  .object({
    kind: z.literal('fs_op'),
    op: z.enum(['roots', 'list', 'walk', 'search', 'mkdir', 'touch', 'rename', 'copy', 'move', 'delete', 'download', 'upload', 'hash']),
    path: z.string().max(1024).optional(),
    paths: z.array(z.string().max(1024)).max(100).optional(),
    target_path: z.string().max(1024).optional(),
    new_name: z.string().max(255).optional(),
    query: z.string().max(200).optional(),
    show_hidden: z.boolean().optional(),
    confirm_destructive: z.boolean().optional(),
    offset: z.number().int().min(0).optional(),
    length: z.number().int().min(1).max(1_048_576).optional(),
    append: z.boolean().optional(),
    /** One upload chunk: at most 1 MiB of bytes (1 398 104 base64 characters). */
    data_base64: z.string().max(1_400_000).optional(),
    expected_sha256: z.string().max(64).optional(),
    /**
     * Upload only: the piece's bytes were sent apart, as binary, to POST /endpoints/:id/file-data
     * (file-manager/relay.ts); this is the id that call returned. Instead of data_base64.
     */
    data_ref: z.string().uuid().optional(),
    /** Download only: send the bytes through the binary side channel (agents that can; ignored otherwise). */
    relay: z.boolean().optional(),
    /** hash only: size, modification time and resume point without reading the whole file. */
    size_only: z.boolean().optional(),
    /** Upload only: replace an existing file. The console sets it only after the operator confirms in a dialog. */
    overwrite: z.boolean().optional(),
  })
  .strict();
export type FsOpCommand = z.infer<typeof fsOpCommandSchema>;
