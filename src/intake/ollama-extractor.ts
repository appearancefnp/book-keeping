import type { DocumentExtractor } from './extractor.js';
import { extractedInvoiceSchema, type ExtractionResult } from './extraction-schema.js';

/**
 * Free, self-hosted, PRIVATE document extractor backed by a local Ollama vision model
 * (default: qwen2.5vl — Apache-2.0, strong invoice/structured-doc extraction).
 *
 * Recommended POC default: no per-call cost, no data leaves the machine (GDPR-friendly,
 * matches the spec's zero-retention posture). Requires Ollama running locally:
 *   ollama pull qwen2.5vl && ollama serve
 *
 * Integration-only (needs a running Ollama); not unit-tested. All pipeline tests use StubExtractor.
 */
export class OllamaExtractor implements DocumentExtractor {
  constructor(
    private readonly host = process.env.OLLAMA_HOST ?? 'http://localhost:11434',
    private readonly model = process.env.OLLAMA_MODEL ?? 'qwen2.5vl',
  ) {}

  async extract(bytes: Buffer, _mime: string): Promise<ExtractionResult> {
    const body = {
      model: this.model,
      stream: false,
      format: 'json',
      messages: [
        {
          role: 'user',
          content:
            'Extract this invoice as JSON {extractedData:{supplierName, supplierRegNo, date (YYYY-MM-DD), currency, lineItems:[{description,net,vatRate,vat}], vatTotal, netTotal, grandTotal}, confidence:{<field>:0..1}}. Amounts as decimal strings. Respond ONLY with that JSON.',
          images: [bytes.toString('base64')],
        },
      ],
    };
    const res = await fetch(`${this.host}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Ollama error ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { message?: { content?: string } };
    const text = json.message?.content ?? '{}';
    let parsed: { extractedData?: unknown; confidence?: Record<string, number> };
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      throw new Error(`OllamaExtractor: model did not return valid JSON: ${text.slice(0, 200)}`);
    }
    return {
      extractedData: extractedInvoiceSchema.parse(parsed.extractedData),
      confidence: parsed.confidence ?? {},
    };
  }
}
