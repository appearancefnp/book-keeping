import type { DocumentExtractor } from './extractor.js';
import { extractedInvoiceSchema, type ExtractionResult } from './extraction-schema.js';

/**
 * Free-tier hosted document extractor backed by Google Gemini (multimodal).
 * Gemini's free tier is generous (no card) and needs zero local setup — the fastest
 * way to make real extraction work for a POC.
 *
 * TRADE-OFF: data leaves your machine to Google, and the free tier's data-use policy
 * is NOT zero-retention. For GDPR-sensitive client data prefer OllamaExtractor (local)
 * or a paid zero-retention tier. Fine for demo/POC with non-sensitive fixtures.
 *
 * Integration-only (needs GEMINI_API_KEY); not unit-tested. Pipeline tests use StubExtractor.
 */
export class GeminiExtractor implements DocumentExtractor {
  constructor(
    private readonly apiKey = process.env.GEMINI_API_KEY ?? '',
    private readonly model = process.env.GEMINI_MODEL ?? 'gemini-2.0-flash',
  ) {}

  async extract(bytes: Buffer, mime: string): Promise<ExtractionResult> {
    if (!this.apiKey) throw new Error('GEMINI_API_KEY is not set');
    const body = {
      contents: [
        {
          parts: [
            { inline_data: { mime_type: mime, data: bytes.toString('base64') } },
            {
              text:
                'Extract this invoice as JSON {extractedData:{supplierName, supplierRegNo, date (YYYY-MM-DD), currency, lineItems:[{description,net,vatRate,vat}], vatTotal, netTotal, grandTotal}, confidence:{<field>:0..1}}. Amounts as decimal strings.',
            },
          ],
        },
      ],
      generationConfig: { responseMimeType: 'application/json' },
    };
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    );
    if (!res.ok) throw new Error(`Gemini error ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
    const parsed = JSON.parse(text) as { extractedData?: unknown; confidence?: Record<string, number> };
    return {
      extractedData: extractedInvoiceSchema.parse(parsed.extractedData),
      confidence: parsed.confidence ?? {},
    };
  }
}
