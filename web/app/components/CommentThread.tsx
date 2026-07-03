'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useMessages } from '@/app/lib/i18n-context';
import styles from './CommentThread.module.css';

interface CommentRow {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

function formatRelativeDate(iso: string): string {
  try {
    const date = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 7) return `${diffDay}d ago`;
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
  } catch {
    return iso;
  }
}

export interface CommentThreadProps {
  taskId: string;
  clientCompanyId: string;
}

export function CommentThread({ taskId, clientCompanyId }: CommentThreadProps) {
  const { t } = useMessages();
  const [comments, setComments] = useState<CommentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [composerBody, setComposerBody] = useState('');
  const [posting, setPosting] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/tasks/${encodeURIComponent(taskId)}/comments?clientCompanyId=${encodeURIComponent(clientCompanyId)}`
      );
      if (!res.ok) return;
      const data = (await res.json()) as { comments: CommentRow[] };
      setComments(data.comments);
    } finally {
      setLoading(false);
    }
  }, [taskId, clientCompanyId]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const body = composerBody.trim();
    if (!body || posting) return;
    setPosting(true);
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientCompanyId, body }),
      });
      if (res.ok) {
        setComposerBody('');
        await load();
      }
    } finally {
      setPosting(false);
    }
  }

  return (
    <div className={styles.thread}>
      {loading && (
        <p className={styles.inlineLoading} aria-live="polite">{t('state.loading')}</p>
      )}

      {!loading && comments.length === 0 && (
        <p className={styles.noComments}>{t('tasks.comment')}</p>
      )}

      {!loading && comments.length > 0 && (
        <ul className={styles.commentList}>
          {comments.map((c) => (
            <li key={c.id} className={styles.comment}>
              <div className={styles.commentMeta}>
                <span className={styles.commentAuthor}>{c.author}</span>
                <time className={styles.commentTime} dateTime={c.createdAt}>
                  {formatRelativeDate(c.createdAt)}
                </time>
              </div>
              <p className={styles.commentBody}>{c.body}</p>
            </li>
          ))}
        </ul>
      )}

      <form className={styles.composer} onSubmit={handleSubmit}>
        <textarea
          ref={textareaRef}
          className={styles.textarea}
          value={composerBody}
          onChange={(e) => setComposerBody(e.target.value)}
          placeholder={t('tasks.addComment')}
          disabled={posting}
          rows={2}
          aria-label={t('tasks.addComment')}
        />
        <button
          type="submit"
          className={styles.btnSubmit}
          disabled={posting || !composerBody.trim()}
        >
          {t('tasks.addComment')}
        </button>
      </form>
    </div>
  );
}
