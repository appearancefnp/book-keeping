import type { ExtractionResult } from './extraction-schema.js';

export interface DocumentExtractor {
  extract(bytes: Buffer, mime: string): Promise<ExtractionResult>;
}

/** Deterministic extractor for tests: returns whatever it was constructed with. */
export class StubExtractor implements DocumentExtractor {
  constructor(private readonly canned: ExtractionResult) {}
  async extract(_bytes: Buffer, _mime: string): Promise<ExtractionResult> {
    return this.canned;
  }
}
