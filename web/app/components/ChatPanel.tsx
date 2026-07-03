'use client';

import { useRef, useState, useEffect, useCallback } from 'react';
import { useMessages } from '@/app/lib/i18n-context';
import styles from './ChatPanel.module.css';

interface Citation {
  key: string;
  value: string;
}

interface Message {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  citations?: Citation[];
}

interface AssistantResponse {
  threadId?: string;
  answer?: string;
  citations?: string[];
  error?: string;
}

let msgCounter = 0;

// Human-readable citation key from a raw citation string (e.g. "account:5721" → "Account 5721")
function parseCitation(raw: string): Citation {
  const colon = raw.indexOf(':');
  if (colon !== -1) {
    const key = raw.slice(0, colon).replace(/[_-]+/g, ' ');
    const humanKey = key.charAt(0).toUpperCase() + key.slice(1);
    return { key: humanKey, value: raw.slice(colon + 1) };
  }
  return { key: 'Source', value: raw };
}

interface ChatPanelProps {
  clientCompanyId: string | null;
}

export function ChatPanel({ clientCompanyId }: ChatPanelProps) {
  const { t } = useMessages();
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [thinking, setThinking] = useState(false);
  const [threadId, setThreadId] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Scroll to bottom whenever messages or thinking state changes
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, thinking]);

  const sendMessage = useCallback(async () => {
    const question = draft.trim();
    if (!question || thinking) return;
    if (!clientCompanyId) {
      setError('No client selected.');
      return;
    }

    const userMsg: Message = { id: ++msgCounter, role: 'user', text: question };
    setMessages((prev) => [...prev, userMsg]);
    setDraft('');
    setThinking(true);
    setError(null);

    try {
      const res = await fetch('/api/assistant', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientCompanyId, question, threadId }),
      });

      const json = (await res.json()) as AssistantResponse;

      if (!res.ok) {
        setError(json.error ?? t('state.error'));
        setThinking(false);
        return;
      }

      if (json.threadId) setThreadId(json.threadId);

      const citations: Citation[] = (json.citations ?? []).map(parseCitation);

      const asstMsg: Message = {
        id: ++msgCounter,
        role: 'assistant',
        text: json.answer ?? '',
        citations,
      };
      setMessages((prev) => [...prev, asstMsg]);
    } catch {
      setError(t('state.error'));
    } finally {
      setThinking(false);
    }
  }, [draft, thinking, clientCompanyId, threadId, t]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
    }
  }

  return (
    <div className={styles.panel}>
      {/* Message list */}
      <div className={styles.messages} role="log" aria-live="polite" aria-label={t('asst.title')}>
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={msg.role === 'user' ? styles.msgUser : styles.msgAsst}
          >
            <p className={styles.msgText}>{msg.text}</p>
            {msg.role === 'assistant' && msg.citations && msg.citations.length > 0 && (
              <div className={styles.citations}>
                <span className={styles.citationsLabel}>{t('asst.sources')}</span>
                <ul className={styles.citationList}>
                  {msg.citations.map((c, i) => (
                    <li key={i} className={styles.citationItem}>
                      <span className={styles.citationKey}>{c.key}</span>
                      <span className={styles.citationVal}>{c.value}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ))}

        {/* Thinking indicator */}
        {thinking && (
          <div className={styles.msgAsst} aria-live="polite">
            <p className={styles.thinking}>{t('asst.thinking')}</p>
          </div>
        )}

        {/* Inline error notice */}
        {error && !thinking && (
          <div className={styles.errorNotice} role="alert">
            {error}
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Composer */}
      <div className={styles.composer}>
        <textarea
          ref={textareaRef}
          className={styles.textarea}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('asst.placeholder')}
          rows={2}
          disabled={thinking}
          aria-label={t('asst.placeholder')}
        />
        <button
          className={styles.sendBtn}
          onClick={() => void sendMessage()}
          disabled={thinking || !draft.trim()}
          aria-label={t('asst.send')}
        >
          {t('asst.send')}
        </button>
      </div>
    </div>
  );
}
