export { getAccessPoint } from '@domain/einvoice/access-point-factory.js';

// Resolved through the shared factory so the web routes, the job worker, and the
// proposal-approval path all issue through one instance. Call getAccessPoint() at the point
// of use (mirroring src/recurring/post-approved.ts and src/jobs/register.ts) rather than at
// module load, so a future connection- and certificate-holding implementation stays lazy.
// Swap the implementation in src/einvoice/access-point-factory.ts when HANDOFF.md #1 lands.
