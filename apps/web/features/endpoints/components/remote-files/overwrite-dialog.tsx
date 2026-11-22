'use client';

import { AlertTriangle } from 'lucide-react';
import { Button, Modal } from '@/components/ui';
import { absoluteTime } from '@/lib/format';
import { ltr } from '@/lib/localize/bidi';
import { formatBytes } from './file-utils';
import type { OverwritePrompt } from './use-remote-files';

/** Asks before an upload replaces a file that already exists on the endpoint. Closing it keeps the file. */
export function OverwriteDialog({ prompt, isAr, onAnswer }: { prompt: OverwritePrompt; isAr: boolean; onAnswer: (confirmed: boolean) => void }) {
  return (
    <Modal title={isAr ? 'استبدال ملف موجود؟' : 'Replace an existing file?'} onClose={() => onAnswer(false)}>
      <div className="space-y-3 text-[13px]">
        <p className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
          <span>
            {isAr
              ? `يوجد ملف باسم ${ltr(prompt.name)} في هذا المجلد على الجهاز البعيد. سيحل الملف المرفوع محله نهائياً، وسيُسجَّل الاستبدال في سجل التدقيق.`
              : `A file named ${prompt.name} already exists in this folder on the endpoint. The upload will permanently replace it, and the overwrite is recorded in the audit log.`}
          </span>
        </p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md border border-line bg-raised p-3 text-xs">
          <dt className="text-muted">{isAr ? 'المسار' : 'Path'}</dt>
          <dd className="mono break-all" dir="ltr">
            {prompt.path}
          </dd>
          {typeof prompt.existingSize === 'number' && (
            <>
              <dt className="text-muted">{isAr ? 'الملف الحالي' : 'Existing file'}</dt>
              <dd>
                <span className="mono" dir="ltr">
                  {formatBytes(prompt.existingSize)}
                </span>
                {prompt.existingModTime && (
                  <span className="text-muted">
                    {' · '}
                    {isAr ? 'آخر تعديل ' : 'modified '}
                    {absoluteTime(prompt.existingModTime, isAr ? 'ar' : 'en')}
                  </span>
                )}
              </dd>
            </>
          )}
          <dt className="text-muted">{isAr ? 'الملف الجديد' : 'New file'}</dt>
          <dd className="mono" dir="ltr">
            {formatBytes(prompt.newSize)}
          </dd>
        </dl>
        <div className="flex justify-end gap-2 pt-1">
          <Button onClick={() => onAnswer(false)}>
            {isAr ? 'إلغاء والإبقاء على الملف' : 'Cancel, keep the file'}
          </Button>
          <Button variant="danger" onClick={() => onAnswer(true)}>
            {isAr ? 'استبدال الملف' : 'Replace file'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
