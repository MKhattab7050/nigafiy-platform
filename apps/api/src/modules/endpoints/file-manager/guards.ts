import { AppError } from '../../../common/http.ts';
import type { FsOpCommand } from './schema.ts';

/** Server-side rules for file operations, checked before a command is queued. */
export function assertFileOperationAllowed(body: FsOpCommand, isAdmin: boolean): void {
  if (body.op === 'delete') {
    if (!body.confirm_destructive) {
      throw new AppError(400, 'confirmation_required', 'Deleting files or folders requires explicit confirmation');
    }
    if (!isAdmin) {
      throw new AppError(403, 'forbidden', 'Deleting remote files requires admin privileges');
    }
  }
  // Uploading can replace files on the endpoint: the same bar as deleting them.
  if (body.op === 'upload' && !isAdmin) {
    throw new AppError(403, 'forbidden', 'Uploading files to an endpoint requires admin privileges');
  }
  // `overwrite` only means something for an upload's first chunk; the agent refuses an existing
  // target without it, and the audit log records every confirmed overwrite.
  if (body.overwrite !== undefined && body.op !== 'upload') {
    throw new AppError(400, 'invalid_option', 'overwrite applies only to uploads');
  }
  if (body.size_only !== undefined && body.op !== 'hash') {
    throw new AppError(400, 'invalid_option', 'size_only applies only to hash');
  }
  if (body.data_ref !== undefined && (body.op !== 'upload' || body.data_base64 !== undefined)) {
    throw new AppError(400, 'invalid_option', 'data_ref replaces data_base64 in an upload');
  }
  if (body.relay !== undefined && body.op !== 'download') {
    throw new AppError(400, 'invalid_option', 'relay applies only to downloads');
  }
  if (body.overwrite === true && (body.offset ?? 0) !== 0) {
    throw new AppError(400, 'invalid_option', 'overwrite is confirmed on the first chunk of an upload (offset 0) only');
  }
}
