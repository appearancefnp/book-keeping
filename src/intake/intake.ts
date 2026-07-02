import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import type { BlobStore } from '../blob/blob-store.js';
import type { DocumentExtractor } from './extractor.js';
import { extractedInvoiceSchema } from './extraction-schema.js';
import { getDocument, setDocumentStatus } from '../documents/documents.js';
import { recordExtraction } from '../documents/extraction.js';
import { validateExtraction } from './validate.js';
import { resolveParty } from './resolve-party.js';
import { extractedToJournalEntry, type PostingTemplate } from './map-posting.js';
import { resolveAutonomy } from '../autonomy/autonomy.js';
import { createProposal, type ProposalStatus, type Rationale } from '../proposals/proposals.js';
import { toCents } from '../db/money.js';

export async function runIntake(
  tx: PoolClient, ctx: TenantContext,
  args: { documentId: string; blob: BlobStore; extractor: DocumentExtractor; template: PostingTemplate },
): Promise<{ proposalId: string; status: ProposalStatus }> {
  const doc = await getDocument(tx, ctx, args.documentId);

  // Extract (LLM behind the adapter).
  await setDocumentStatus(tx, ctx, doc.id, 'extracting');
  const { bytes, mime } = await args.blob.get(doc.storageKey);
  const result = await args.extractor.extract(bytes, mime);
  const extracted = extractedInvoiceSchema.parse(result.extractedData);

  // Persist the extraction version (also sets document status 'extracted').
  await recordExtraction(tx, ctx, doc.id, { extractedData: extracted, confidence: result.confidence });

  // Deterministic validation + party resolution.
  const report = validateExtraction(extracted, result.confidence);
  const party = await resolveParty(tx, ctx, extracted);
  const needsReview = !report.valid || report.lowConfidenceFields.length > 0 || party.isNew;

  // Draft the posting.
  const entry = { ...extractedToJournalEntry(extracted, args.template), sourceDocumentId: doc.id };

  // Decide status: guardrails + validation gate.
  const grandTotalCents = toCents(extracted.grandTotal);
  const amountCents = grandTotalCents < 0n ? -grandTotalCents : grandTotalCents;
  const autonomy = await resolveAutonomy(tx, ctx, 'posting', { amountCents });
  const status: ProposalStatus = needsReview || autonomy === 'approval' ? 'pending_approval' : 'suggested';

  const { id: proposalId } = await createProposal(tx, ctx, {
    type: 'posting',
    documentId: doc.id,
    payload: entry,
    status,
    rationale: {
      ruleRef: 'purchase-invoice-template',
      computation: `net ${extracted.netTotal} + VAT ${extracted.vatTotal} = ${extracted.grandTotal}`,
      sourceRefs: { documentId: doc.id, partyId: party.partyId, partyIsNew: party.isNew },
      validationIssues: report.issues,
      lowConfidenceFields: report.lowConfidenceFields,
      autonomy,
    } as Rationale,
  });

  await setDocumentStatus(tx, ctx, doc.id, needsReview ? 'needs_review' : 'extracted');
  return { proposalId, status };
}
