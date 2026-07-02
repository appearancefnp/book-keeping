export interface AuthedRequest { token: string; clientCompanyId: string; params?: Record<string, string>; body?: unknown; atUnixSeconds: number; }
export interface ApiResponse { status: number; body: unknown; }
