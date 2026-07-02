# Open-source / free OCR & LLM options for the POC

The document-extraction and (future) chatbot layers sit behind **injectable adapter interfaces**
(`DocumentExtractor` in `src/intake/extractor.ts`), so we can swap the provider without touching the
pipeline. This note surveys free/OSS options and states what we ship for the proof-of-concept.

## TL;DR — what the POC uses

- **The whole pipeline already runs free with `StubExtractor`** (deterministic fixture data). Every
  test and the seed/demo work with **no LLM and no API key** — the POC is demoable today.
- **For real extraction, free, recommended default: `OllamaExtractor` + `qwen2.5vl` (local).**
  Apache-2.0, runs on your machine, **no per-call cost and no data leaves the host** — which matches
  the design spec's GDPR / zero-retention posture. Added at `src/intake/ollama-extractor.ts`.
- **Zero-setup hosted alternative: `GeminiExtractor` (Google Gemini free tier).** Generous free tier,
  no card, multimodal. **Caveat: not zero-retention** — fine for demo fixtures, not real client data.
  Added at `src/intake/gemini-extractor.ts`.
- Paid, production-grade, zero-retention path stays available via `AnthropicExtractor` (needs a key).

All three implement the same `DocumentExtractor` interface, so `runIntake(...)` / the mobile capture
handler take whichever you inject — no pipeline change.

## OCR / document extraction

Two families:

**A. Vision-LLM extracts structured fields directly (no separate OCR step).** This is what our
pipeline expects — `DocumentExtractor.extract(bytes, mime) → {extractedData, confidence}`.
- **Qwen2.5-VL** (3B / 7B / 72B, Apache-2.0) — strong invoice/receipt/table structured extraction
  (~95.7 DocVQA on the 7B), runs locally via **Ollama** (`ollama pull qwen2.5vl`), ~6-8 GB for 7B.
  **Our recommended free+private default.**
- Other strong local VLMs: GLM-4.5V, DeepSeek-VL2, Llama 3.2 Vision, NVIDIA Nemotron Nano 2 VL.
- Hosted free tiers with vision: **Google Gemini Flash** (best free tier — ~1,500 req/day, 1M ctx,
  no card), **Groq** (fast, but free RPD reduced in 2026), **OpenRouter** free models (~200 RPD/model).

**B. Classic OCR (image → text/layout), then our code/LLM structures it.** Useful if we want a
cheaper non-LLM first pass or to feed a text-only model:
- **PaddleOCR** (Apache-2.0) — best OSS for *structured* invoices; `PP-Structure` does layout + table
  recognition with row/column relationships. Python; GPU helps.
- **Tesseract** — simplest, fastest to prototype, permissive license. Weaker on messy/table docs.
- **docTR** (Apache-2.0) — layout-aware, gives spatial text for your own extraction logic.
- **EasyOCR** — good on messy real-world scans.
- **Surya** — excellent accuracy + tables, **but GPL** → license caution for a commercial product.

License note for a commercial product: prefer **Apache-2.0/MIT** (Qwen2.5-VL, PaddleOCR, docTR,
Tesseract) and **avoid GPL** (Surya) unless you accept its terms.

## LLM chatbot (the conversational assistant — Phase 2)

Same adapter approach. Free/OSS options:
- **Local: Ollama** running Qwen2.5 / Llama 3.x / Mistral — free, private, no key. Best fit for the
  GDPR posture; needs local/GPU compute.
- **Hosted free tiers:** Google Gemini Flash (most generous), Groq (fastest), Cerebras (~1M
  tokens/day), OpenRouter (many free models, one key). For sensitive data prefer providers with a
  stated no-training policy (OpenRouter/Groq/Cerebras) or self-host.
- **Vercel AI Gateway** (if we deploy on Vercel) can front any of these behind one API with
  fallbacks — useful later, not required for the POC.

## How to switch the extractor

```ts
// StubExtractor (default in tests/seed — no LLM):
import { StubExtractor } from './intake/extractor.js';

// Local, free, private (recommended real POC): run `ollama serve` + `ollama pull qwen2.5vl`
import { OllamaExtractor } from './intake/ollama-extractor.js';   // OLLAMA_HOST / OLLAMA_MODEL

// Hosted free tier (fastest to try, not zero-retention): set GEMINI_API_KEY
import { GeminiExtractor } from './intake/gemini-extractor.js';   // GEMINI_API_KEY / GEMINI_MODEL

// Paid, zero-retention production: set ANTHROPIC_API_KEY
import { AnthropicExtractor } from './intake/anthropic-extractor.js';
```

The web capture handler takes the extractor via its factory (`makeCaptureHandler({ blob, extractor, resolveTemplate })`), so wiring a different one is a one-line change at the composition point.

## Sources
- [Best Open Source OCR Tools & Models for Developers in 2026 — Unstract](https://unstract.com/blog/best-opensource-ocr-tools/)
- [8 Top Open-Source OCR Models Compared — Modal](https://modal.com/blog/8-top-open-source-ocr-models-compared)
- [Open Source OCR for Invoice Extraction — invoicedataextraction.com](https://invoicedataextraction.com/blog/open-source-ocr-invoice-extraction)
- [Free LLM APIs in 2026 compared — OpenRouter](https://openrouter.ai/blog/tutorials/free-llm-apis-compared/)
- [Best Free LLM API 2026: Gemini, Groq, OpenRouter — costbench](https://costbench.com/best/best-llm-api-with-free-tier/)
- [qwen2.5vl — Ollama library](https://ollama.com/library/qwen2.5vl)
- [Run Qwen2.5-VL 7B Locally — Labellerr](https://www.labellerr.com/blog/run-qwen2-5-vl-locally/)
- [free-llm-api-resources — GitHub (cheahjs)](https://github.com/cheahjs/free-llm-api-resources)
