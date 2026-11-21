'use client';

import { MessageSquarePlus, Send, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button, Card, ErrorNote, SkeletonBlock, Textarea } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { relativeTime } from '@/lib/format';
import { fill, useI18n } from '@/lib/i18n';
import type { AssistantAnswer, AssistantStatus, Citation, ConversationDetail, ConversationSummary, Lookup } from '../types';
import { AnswerView } from './answer-view';

interface Message {
  role: 'user' | 'assistant';
  text: string;
  citations?: Citation[];
  sources?: Citation[];
  lookups?: Lookup[];
  model?: string;
  usage?: { input_tokens: number; output_tokens: number };
  refused?: boolean;
  truncated?: boolean;
}

/**
 * The chat. When the organization keeps transcripts the server holds the history (by conversation
 * id); otherwise the earlier turns are sent back with each question and live only in this page.
 */
export function ChatPanel({ status, onAsked }: { status: AssistantStatus; onAsked: () => void }) {
  const { t, locale } = useI18n();
  const { siteId } = useApp();
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const history = useQuery<{ keep_transcripts: boolean; items: ConversationSummary[] }>(status.keep_transcripts ? '/assistant/conversations' : null, [], 0);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [messages, busy]);

  async function ask() {
    const q = question.trim();
    if (!q) return;
    setBusy(true);
    setError(null);
    const earlier = messages;
    setMessages([...earlier, { role: 'user', text: q }]);
    setQuestion('');
    try {
      const body = {
        question: q,
        locale,
        site_id: siteId,
        ...(conversationId && status.keep_transcripts ? { conversation_id: conversationId } : {}),
        history: status.keep_transcripts ? [] : earlier.slice(-20).map((m) => ({ role: m.role, text: m.text.slice(0, 8000) })),
      };
      const a = await api<AssistantAnswer>('/assistant/ask', { method: 'POST', body });
      setConversationId(a.conversation_id);
      setMessages((m) => [...m, { role: 'assistant', text: a.text, citations: a.citations, sources: a.sources, lookups: a.lookups, model: a.model, usage: a.usage, refused: a.refused, truncated: a.truncated }]);
      if (a.transcript_stored) history.reload();
      onAsked();
    } catch (err) {
      setError(err as ApiError);
      setMessages(earlier);
      setQuestion(q);
    } finally {
      setBusy(false);
    }
  }

  async function openConversation(id: string) {
    setError(null);
    try {
      const c = await api<ConversationDetail>(`/assistant/conversations/${id}`);
      setConversationId(c.id);
      setMessages(c.messages.map((m) => ({ role: m.role, text: m.text, citations: m.citations, lookups: m.lookups })));
    } catch (err) {
      setError(err as ApiError);
    }
  }

  async function deleteConversation(id: string) {
    setError(null);
    try {
      await api(`/assistant/conversations/${id}`, { method: 'DELETE' });
      if (id === conversationId) {
        setConversationId(undefined);
        setMessages([]);
      }
      history.reload();
    } catch (err) {
      setError(err as ApiError);
    }
  }

  const reset = () => {
    setConversationId(undefined);
    setMessages([]);
    setError(null);
  };

  return (
    <div className={status.keep_transcripts ? 'grid gap-4 lg:grid-cols-[minmax(0,1fr)_16rem]' : ''}>
      <Card
        title={t('ai.chat.title')}
        description={t(status.keep_transcripts ? 'ai.chat.kept' : 'ai.chat.notKept')}
        action={
          messages.length > 0 && (
            <Button size="sm" variant="ghost" onClick={reset}>
              <MessageSquarePlus className="size-3.5" aria-hidden />
              {t('ai.chat.new')}
            </Button>
          )
        }
      >
        <div className="space-y-4" aria-live="polite">
          {messages.length === 0 && !busy && <p className="text-[13px] text-muted">{t('ai.chat.empty')}</p>}
          {messages.map((m, i) =>
            m.role === 'user' ? (
              <div key={i} className="ms-auto max-w-[85%] rounded-[10px] bg-accent/10 px-3 py-2 text-[13px]" dir="auto">
                <span className="sr-only">{t('ai.chat.you')}: </span>
                {m.text}
              </div>
            ) : (
              <div key={i} className="rounded-[10px] border border-line px-3 py-2.5">
                <AnswerView text={m.text} citations={m.citations ?? []} sources={m.sources} lookups={m.lookups ?? []} model={m.model} usage={m.usage} refused={m.refused} truncated={m.truncated} />
              </div>
            ),
          )}
          {busy && (
            <div className="rounded-[10px] border border-line px-3 py-2.5">
              <p className="mb-2 text-xs text-muted">{t('ai.chat.thinking')}</p>
              <SkeletonBlock lines={3} />
            </div>
          )}
          <div ref={endRef} />
        </div>
        {error && (
          <div className="mt-3">
            <ErrorNote error={error} />
          </div>
        )}
        <form
          className="mt-4 flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void ask();
          }}
        >
          <Textarea
            aria-label={t('ai.chat.title')}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void ask();
              }
            }}
            placeholder={t('ai.chat.placeholder')}
            rows={2}
            maxLength={4000}
            dir="auto"
            className="min-h-0 flex-1"
          />
          <Button type="submit" variant="primary" busy={busy} disabled={!question.trim()}>
            <Send className="size-3.5 rtl:-scale-x-100" aria-hidden />
            {t('ai.chat.send')}
          </Button>
        </form>
      </Card>
      {status.keep_transcripts && (
        <Card title={t('ai.chat.history')} padded={false}>
          {history.data && history.data.items.length === 0 && <p className="px-4 py-3 text-[13px] text-muted">{t('ai.chat.noHistory')}</p>}
          {history.error && (
            <div className="p-3">
              <ErrorNote error={history.error} onRetry={history.reload} />
            </div>
          )}
          <ul className="divide-y divide-line">
            {history.data?.items.map((c) => (
              <li key={c.id} className={`flex items-start gap-1 px-2 py-1.5 ${c.id === conversationId ? 'bg-raised' : ''}`}>
                <button type="button" onClick={() => void openConversation(c.id)} className="min-w-0 flex-1 rounded px-2 py-1 text-start hover:bg-raised">
                  <span className="block truncate text-[13px]" dir="auto">
                    {c.title || '—'}
                  </span>
                  <span className="block text-[11px] text-faint">
                    {fill(t('ai.chat.messages'), { n: c.messages })} · {relativeTime(c.updated_at, locale)}
                  </span>
                </button>
                <Button size="sm" variant="ghost" aria-label={t('ai.chat.deleteConv')} title={t('ai.chat.deleteConv')} onClick={() => void deleteConversation(c.id)}>
                  <Trash2 className="size-3.5" aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
