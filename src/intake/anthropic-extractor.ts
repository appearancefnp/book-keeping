import type { DocumentExtractor } from './extractor.js';
import { extractedInvoiceSchema, type ExtractionResult } from './extraction-schema.js';

/**
 * Real extractor backed by the Anthropic Messages API. Integration-only: requires ANTHROPIC_API_KEY.
 * Not unit-tested (all pipeline tests use StubExtractor).
 *
 * Model ID and API details sourced from the claude-api skill (2026-07-02):
 *   - model: claude-opus-4-8 (current recommended model with vision)
 *   - anthropic-version: 2023-06-01
 *   - image content block: {type: "image", source: {type: "base64", media_type, data}}
 */
export class AnthropicExtractor implements DocumentExtractor {
  constructor(
    private readonly apiKey = process.env['ANTHROPIC_API_KEY'] ?? '',
    private readonly model = process.env['EXTRACTOR_MODEL'] ?? 'claude-opus-4-8',
  ) {}

  async extract(bytes: Buffer, mime: string): Promise<ExtractionResult> {
    if (!this.apiKey) throw new Error('ANTHROPIC_API_KEY is not set');

    const body = {
      model: this.model,
      max_tokens: 2048,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mime,
                data: bytes.toString('base64'),
              },
            },
            {
              type: 'text',
              text: 'Extract this invoice as JSON matching {supplierName, supplierRegNo, date (YYYY-MM-DD), currency, lineItems:[{description,net,vatRate,vat}], vatTotal, netTotal, grandTotal}. Also return a confidence 0-1 per top-level field. Respond ONLY with JSON {extractedData, confidence}.',
            },
          ],
        },
      ],
    };

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);

    const json = (await res.json()) as { content: Array<{ type: string; text?: string }> };
    const text = json.content.find((c) => c.type === 'text')?.text ?? '{}';
    const parsed = JSON.parse(text) as { extractedData: unknown; confidence: Record<string, number> };

    return {
      extractedData: extractedInvoiceSchema.parse(parsed.extractedData),
      confidence: parsed.confidence ?? {},
    };
  }
}
