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
  // Uploading overwrites files on the endpoint: the same bar as deleting them.
  if (body.op === 'upload' && !isAdmin) {
    throw new AppError(403, 'forbidden', 'Uploading files to an endpoint requires admin privileges');
  }
}
