import { type AccessPoint, StubAccessPoint } from './access-point.js';

// Mirrors makeBlobStore() in src/blob/factory.ts: one place that decides which implementation the
// process uses. Swap the constructor here when the real provider lands (HANDOFF.md #1) — the
// AccessPoint interface and every call site stay unchanged.
//
// Singleton rather than new-per-call: a real Access Point holds a connection and client
// certificate, so one instance per process is correct. StubAccessPoint's in-memory `sent` array is
// read only by tests, which construct their own instance directly.
let instance: AccessPoint | null = null;

export function getAccessPoint(): AccessPoint {
  if (!instance) instance = new StubAccessPoint();
  return instance;
}
