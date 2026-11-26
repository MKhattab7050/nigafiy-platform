'use client';

import { Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button, ErrorNote, Modal, Notice, useConfirm } from '@/components/ui';
import { QrCode } from '@/features/endpoints/components/android/qr-code';
import { type ApiError, api } from '@/lib/api';
import { relativeTime } from '@/lib/format';
import { type Key, fill, useI18n } from '@/lib/i18n';

// Telegram by QR (UX review item 10): the phone scans https://t.me/<bot>?start=<one-time code>, the
// person presses Start, and the API's update reader links that chat. This window waits for the link
// by re-reading the linked chats every few seconds.

interface LinkCode {
  url: string;
  bot_username: string;
  expires_at: string;
}

interface LinkedChat {
  id: string;
  chat_type: 'private' | 'group' | 'supergroup' | 'channel';
  title: string;
  language: 'en' | 'ar';
  linked_at: string;
}

interface ChatsResponse {
  items: LinkedChat[];
  legacy_chat_id: string | null;
  bot_username: string | null;
  polling: { last_poll_at: string | null; last_error: string | null; healthy: boolean };
}

const WAIT_MS = 3_000;

export function TelegramLinkModal({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const { t, locale } = useI18n();
  const confirm = useConfirm();
  const [code, setCode] = useState<LinkCode | null>(null);
  const [chats, setChats] = useState<ChatsResponse | null>(null);
  const [linked, setLinked] = useState<LinkedChat | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const known = useRef<Set<string> | null>(null);
  const tested = useRef(false);

  const newCode = useCallback(async () => {
    setBusy(true);
    setError(null);
    setLinked(null);
    try {
      setCode(await api<LinkCode>(`/notification-channels/${channelId}/telegram-link`, { method: 'POST', body: { language: locale === 'ar' ? 'ar' : 'en' } }));
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  }, [channelId, locale]);

  const readChats = useCallback(async () => {
    try {
      const r = await api<ChatsResponse>(`/notification-channels/${channelId}/telegram-chats`);
      setChats(r);
      if (known.current === null) {
        known.current = new Set(r.items.map((c) => c.id));
        return;
      }
      const fresh = r.items.find((c) => !known.current!.has(c.id));
      if (fresh) {
        for (const c of r.items) known.current.add(c.id);
        setLinked(fresh);
        setCode(null);
        // The first chat linked in this window gets a test message, so the person sees it work.
        if (!tested.current) {
          tested.current = true;
          await api(`/notification-channels/${channelId}/test`, { method: 'POST' }).catch(() => undefined);
        }
      }
    } catch (err) {
      setError(err as ApiError);
    }
  }, [channelId]);

  useEffect(() => {
    void readChats().then(() => newCode());
  }, [readChats, newCode]);

  useEffect(() => {
    if (!code) return;
    const timer = setInterval(() => void readChats(), WAIT_MS);
    return () => clearInterval(timer);
  }, [code, readChats]);

  async function unlink(chat: LinkedChat) {
    if (!(await confirm(fill(t('tglink.unlinkConfirm'), { name: chat.title }), { destructive: true, confirmLabel: t('tglink.unlink') }))) return;
    try {
      await api(`/notification-channels/${channelId}/telegram-chats/${chat.id}`, { method: 'DELETE' });
      await readChats();
    } catch (err) {
      setError(err as ApiError);
    }
  }

  const expired = code ? new Date(code.expires_at).getTime() <= Date.now() : false;

  return (
    <Modal title={t('tglink.title')} onClose={onClose}>
      {chats?.polling.last_error && (
        <p className="mb-3 rounded-[var(--radius-control)] border border-warn/40 bg-warn/10 px-3 py-2 text-[13px]">
          {fill(t('tglink.pollProblem'), { error: chats.polling.last_error })}
        </p>
      )}

      {linked && <Notice className="mb-3">{fill(t('tglink.linkedNow'), { name: linked.title })}</Notice>}

      {code && !expired ? (
        <div className="flex flex-col items-center gap-3 text-center">
          <p className="text-[13px] text-muted">{t('tglink.scan')}</p>
          <QrCode value={code.url} label={t('tglink.qrLabel')} />
          <a href={code.url} target="_blank" rel="noreferrer" className="text-xs font-medium text-accent-hover hover:underline" dir="ltr">
            {t('tglink.openLink')} · @{code.bot_username}
          </a>
          <p className="text-xs text-faint">{fill(t('tglink.expires'), { time: relativeTime(code.expires_at, locale) })}</p>
          <p role="status" className="text-xs text-muted">
            {t('tglink.waiting')}
          </p>
        </div>
      ) : (
        <div className="flex justify-center">
          <Button busy={busy} onClick={() => void newCode()}>
            {linked ? t('tglink.another') : t('tglink.newCode')}
          </Button>
        </div>
      )}

      {error && (
        <div className="mt-3">
          <ErrorNote error={error} />
        </div>
      )}

      <div className="mt-5">
        <h3 className="mb-1.5 text-xs font-medium text-muted">{t('tglink.chats')}</h3>
        {chats && (chats.items.length || chats.legacy_chat_id) ? (
          <ul className="divide-y divide-line rounded-md border border-line">
            {chats.legacy_chat_id && (
              <li className="flex items-center gap-2 px-3 py-2 text-[13px]">
                <span className="mono" dir="ltr">
                  {chats.legacy_chat_id}
                </span>
                <Badge tone="idle" dot={false}>
                  {t('tglink.typedChat')}
                </Badge>
              </li>
            )}
            {chats.items.map((c) => (
              <li key={c.id} className="flex items-center gap-2 px-3 py-2 text-[13px]">
                <span dir="auto">{c.title}</span>
                <Badge tone="idle" dot={false}>
                  {t(`tglink.chatType.${c.chat_type}` as Key)}
                </Badge>
                <span className="text-xs text-faint">{relativeTime(c.linked_at, locale)}</span>
                <Button size="sm" variant="ghost" className="ms-auto" aria-label={`${t('tglink.unlink')}: ${c.title}`} onClick={() => void unlink(c)}>
                  <Trash2 className="size-3.5" aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-muted">{t('tglink.noChats')}</p>
        )}
      </div>

      <div className="mt-4 flex justify-end">
        <Button variant={linked ? 'primary' : 'ghost'} onClick={onClose}>
          {t('tglink.done')}
        </Button>
      </div>
    </Modal>
  );
}
