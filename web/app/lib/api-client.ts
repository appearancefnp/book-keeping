import type { Proposal } from './proposal-types';

export interface ClientCompany { id: string; name: string; regNo: string; baseCurrency: string; }

export interface SessionInfo { userId: string; firmId: string; role: string; }

async function jsonOrThrow(res: Response): Promise<unknown> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data as { error?: string }).error ?? `Request failed (${res.status})`;
    const err = new Error(msg) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return data;
}

export async function fetchClients(): Promise<{ clients: ClientCompany[]; role: string }> {
  const data = await jsonOrThrow(await fetch('/api/clients', { cache: 'no-store' }));
  return data as { clients: ClientCompany[]; role: string };
}

export async function fetchProposals(clientCompanyId: string): Promise<Proposal[]> {
  const data = await jsonOrThrow(
    await fetch(`/api/proposals?clientCompanyId=${encodeURIComponent(clientCompanyId)}`, { cache: 'no-store' }),
  );
  return (data as { proposals: Proposal[] }).proposals;
}

export async function approveProposal(id: string, clientCompanyId: string): Promise<void> {
  await jsonOrThrow(await fetch(`/api/proposals/${encodeURIComponent(id)}/approve`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientCompanyId }),
  }));
}

export async function rejectProposal(id: string, clientCompanyId: string, reason: string): Promise<void> {
  await jsonOrThrow(await fetch(`/api/proposals/${encodeURIComponent(id)}/reject`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientCompanyId, reason }),
  }));
}

export async function login(email: string, password: string, code: string): Promise<void> {
  await jsonOrThrow(await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, code }),
  }));
}

export async function logout(): Promise<void> {
  await jsonOrThrow(await fetch('/api/auth/logout', { method: 'POST' }));
}

export async function fetchMe(): Promise<SessionInfo | null> {
  const res = await fetch('/api/auth/me', { cache: 'no-store' });
  if (res.status === 401) return null;
  const data = await jsonOrThrow(res);
  return data as SessionInfo;
}
