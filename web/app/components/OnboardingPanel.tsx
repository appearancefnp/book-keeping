'use client';

import { useState } from 'react';
import { useMessages } from '@/app/lib/i18n-context';
import styles from './OnboardingPanel.module.css';

export interface TemplateSummary {
  id: string; name: string; accountCount: number; policyCount: number; hasTariff: boolean;
}

interface OnboardingPanelProps {
  clients: { id: string; name: string }[];
  templates: TemplateSummary[];
  role: string;
  onChanged: () => void;
}

export function OnboardingPanel({ clients, templates, role, onChanged }: OnboardingPanelProps) {
  const { t } = useMessages();
  if (role !== 'firm_admin') {
    // Accountant: read-only template list only.
    return <TemplatesList templates={templates} />;
  }
  return (
    <>
      <AddClientForm templates={templates} onChanged={onChanged} />
      <SaveTemplateForm clients={clients} onChanged={onChanged} />
      <TemplatesList templates={templates} />
    </>
  );
}

function TemplatesList({ templates }: { templates: TemplateSummary[] }) {
  const { t } = useMessages();
  return (
    <section className={styles.section} aria-labelledby="onb-templates-heading">
      <h2 id="onb-templates-heading" className={styles.heading}>{t('admin.onb.templates')}</h2>
      {templates.length === 0 ? (
        <p className={styles.muted}>{t('admin.onb.empty')}</p>
      ) : (
        <ul className={styles.list}>
          {templates.map((tpl) => (
            <li key={tpl.id} className={styles.item}>
              <span>{tpl.name}</span>
              <span className={styles.muted}>
                {t('admin.onb.summary')
                  .replace('{a}', String(tpl.accountCount))
                  .replace('{p}', String(tpl.policyCount))
                  .replace('{t}', tpl.hasTariff ? '✓' : '–')}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AddClientForm({ templates, onChanged }: { templates: TemplateSummary[]; onChanged: () => void }) {
  const { t } = useMessages();
  const [name, setName] = useState('');
  const [regNo, setRegNo] = useState('');
  const [currency, setCurrency] = useState('EUR');
  const [templateId, setTemplateId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  async function submit() {
    if (!name.trim() || !regNo.trim()) { setError(true); return; }
    setBusy(true); setError(false);
    try {
      const res = await fetch('/api/admin/clients', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, regNo, baseCurrency: currency, templateId: templateId || null }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setName(''); setRegNo(''); setTemplateId('');
      onChanged();
    } catch { setError(true); } finally { setBusy(false); }
  }

  return (
    <section className={styles.section} aria-labelledby="onb-add-heading">
      <h2 id="onb-add-heading" className={styles.heading}>{t('admin.onb.addClient')}</h2>
      <div className={styles.form}>
        <label className={styles.field}>{t('admin.onb.name')}
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className={styles.field}>{t('admin.onb.regNo')}
          <input value={regNo} onChange={(e) => setRegNo(e.target.value)} />
        </label>
        <label className={styles.field}>{t('admin.onb.currency')}
          <input value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
        </label>
        <label className={styles.field}>{t('admin.onb.template')}
          <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            <option value="">{t('admin.onb.noTemplate')}</option>
            {templates.map((tpl) => <option key={tpl.id} value={tpl.id}>{tpl.name}</option>)}
          </select>
        </label>
        <button type="button" onClick={submit} disabled={busy}>{t('admin.onb.create')}</button>
      </div>
      {error && <p className={styles.error} role="alert">{t('admin.onb.error')}</p>}
    </section>
  );
}

function SaveTemplateForm({ clients, onChanged }: { clients: { id: string; name: string }[]; onChanged: () => void }) {
  const { t } = useMessages();
  const [clientCompanyId, setClientCompanyId] = useState(clients[0]?.id ?? '');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  async function submit() {
    if (!clientCompanyId || !name.trim()) { setError(true); return; }
    setBusy(true); setError(false);
    try {
      const res = await fetch('/api/admin/templates', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientCompanyId, name }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setName('');
      onChanged();
    } catch { setError(true); } finally { setBusy(false); }
  }

  return (
    <section className={styles.section} aria-labelledby="onb-save-heading">
      <h2 id="onb-save-heading" className={styles.heading}>{t('admin.onb.saveAsTemplate')}</h2>
      <div className={styles.form}>
        <label className={styles.field}>{t('admin.onb.sourceClient')}
          <select value={clientCompanyId} onChange={(e) => setClientCompanyId(e.target.value)}>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className={styles.field}>{t('admin.onb.templateName')}
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <button type="button" onClick={submit} disabled={busy}>{t('admin.onb.save')}</button>
      </div>
      {error && <p className={styles.error} role="alert">{t('admin.onb.error')}</p>}
    </section>
  );
}
