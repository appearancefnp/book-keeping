export interface TenantContext {
  firmId: string;
  clientCompanyId: string;
  actorId: string;   // user id, or 'agent'
  actorRole: string; // 'accountant' | 'owner' | 'employee' | 'admin' | 'agent'
}
