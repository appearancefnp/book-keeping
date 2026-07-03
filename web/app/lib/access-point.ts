import { StubAccessPoint } from '@domain/einvoice/access-point.js';

// Single Access Point used by the einvoice routes. Currently the in-memory
// stub — swap for the real provider implementation when HANDOFF.md #1 lands;
// the AccessPoint interface stays the same.
export const accessPoint = new StubAccessPoint();
