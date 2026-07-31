import { getAccessPoint } from '@domain/einvoice/access-point-factory.js';

// Single Access Point used by the einvoice routes, resolved through the shared factory so the
// web routes, the job worker, and the proposal-approval path all issue through one instance.
// Swap the implementation in src/einvoice/access-point-factory.ts when HANDOFF.md #1 lands.
export const accessPoint = getAccessPoint();
