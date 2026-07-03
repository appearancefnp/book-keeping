'use client';

import { useCallback, useRef, useState } from 'react';
import { useMessages } from '@/app/lib/i18n-context';
import styles from './FileDropzone.module.css';

export interface FileDropzoneProps {
  clientCompanyId: string;
  uploadLabel: string;
  onUploaded: () => void;
  onToast: (message: string, kind: 'ok' | 'error') => void;
}

const ACCEPT = ['image/*', 'application/pdf'];
const ACCEPT_STR = ACCEPT.join(',');

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Strip the data:<mime>;base64, prefix — send raw base64 only
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function isAccepted(file: File): boolean {
  if (file.type.startsWith('image/')) return true;
  if (file.type === 'application/pdf') return true;
  return false;
}

export function FileDropzone({ clientCompanyId, uploadLabel, onUploaded, onToast }: FileDropzoneProps) {
  const { t } = useMessages();
  const inputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);

  const processFile = useCallback(async (file: File) => {
    if (!isAccepted(file)) {
      onToast(t('docs.badType'), 'error');
      return;
    }
    setFileName(file.name);
    setUploading(true);
    try {
      const bytesBase64 = await toBase64(file);
      const res = await fetch('/api/documents/capture', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientCompanyId, bytesBase64, mime: file.type }),
      });
      const data = (await res.json()) as { documentId?: string; proposalId?: string; error?: string };
      if (!res.ok) {
        throw new Error(data.error ?? `Upload failed (${res.status})`);
      }
      onToast(t('docs.uploaded'), 'ok');
      onUploaded();
    } catch (err) {
      const e = err as Error;
      onToast(e.message ?? t('docs.uploadFailed'), 'error');
    } finally {
      setUploading(false);
      setFileName(null);
      if (inputRef.current) inputRef.current.value = '';
      if (cameraInputRef.current) cameraInputRef.current.value = '';
    }
  }, [clientCompanyId, onToast, onUploaded, t]);

  // ── Drag handlers ────────────────────────────────────────────────────────

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(true);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  }, [processFile]);

  const onInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
  }, [processFile]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      inputRef.current?.click();
    }
  }, []);

  return (
    <div className={styles.wrap}>
    <div
      className={[styles.zone, dragging ? styles.dragging : '', uploading ? styles.uploading : ''].filter(Boolean).join(' ')}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onClick={() => !uploading && inputRef.current?.click()}
      onKeyDown={onKeyDown}
      role="button"
      tabIndex={uploading ? -1 : 0}
      aria-label={uploadLabel}
      aria-disabled={uploading}
      aria-busy={uploading}
    >
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT_STR}
        className={styles.hiddenInput}
        onChange={onInputChange}
        tabIndex={-1}
        aria-hidden="true"
        disabled={uploading}
      />

      <span className={styles.icon} aria-hidden="true">
        {uploading ? (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className={styles.spinner}>
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" strokeDasharray="28 28" />
          </svg>
        ) : (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <path
              d="M12 16V8M12 8l-3 3M12 8l3 3"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
            />
          </svg>
        )}
      </span>

      <span className={styles.label}>
        {uploading
          ? (fileName ? `${t('docs.uploading').replace('…', '')} ${fileName}…` : t('docs.uploading'))
          : uploadLabel}
      </span>

      {!uploading && (
        <span className={styles.hint}>
          {t('docs.hint')}
        </span>
      )}
    </div>

    {/* Camera path — visible only on coarse-pointer (touch) devices via CSS.
        capture="environment" opens the rear camera directly on phones. */}
    <input
      ref={cameraInputRef}
      type="file"
      accept="image/*"
      capture="environment"
      className={styles.hiddenInput}
      onChange={onInputChange}
      tabIndex={-1}
      aria-hidden="true"
      disabled={uploading}
    />
    <button
      type="button"
      className={styles.cameraBtn}
      onClick={() => !uploading && cameraInputRef.current?.click()}
      disabled={uploading}
    >
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path
          d="M2 5.5A1.5 1.5 0 013.5 4h1.4l.8-1.3a1 1 0 01.85-.47h2.9a1 1 0 01.85.47l.8 1.3h1.4A1.5 1.5 0 0114 5.5v6A1.5 1.5 0 0112.5 13h-9A1.5 1.5 0 012 11.5v-6z"
          stroke="currentColor"
          strokeWidth="1.25"
          strokeLinejoin="round"
        />
        <circle cx="8" cy="8.25" r="2.25" stroke="currentColor" strokeWidth="1.25" />
      </svg>
      {t('docs.takePhoto')}
    </button>
    </div>
  );
}
