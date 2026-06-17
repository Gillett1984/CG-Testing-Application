import fs from 'node:fs/promises';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { z } from 'zod';
import { topicDefinitionSchema } from './scenarioSchemas.js';

const draftCriterionSchema = z.object({
  requirement: z.string().min(1),
  required: z.boolean(),
  termIds: z.array(z.string().min(1)).min(1)
});

const draftQuestionSchema = z.object({
  discussionArea: z.string().min(1),
  question: z.string().min(1),
  answerGuidance: z.array(z.string().min(1)).min(1),
  primaryTermId: z.string().min(1),
  highQualityCriteria: z.array(draftCriterionSchema).min(1),
  voluntaryCoverageRequirement: z.string().min(1).default('50%')
});

export const topicDraftSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  status: z.enum(['draft', 'approved', 'published']),
  topicId: z.string().min(1),
  caseType: z.string().min(1),
  description: z.string().min(1),
  sourceFileName: z.string().min(1),
  sourceExtractPath: z.string().min(1),
  workflow: z.object({
    actors: z.array(z.enum(['requestor', 'participant'])).min(1),
    factStatementLabel: z.string().min(1),
    postProcessingTimeoutMs: z.number().int().positive()
  }),
  terms: z.array(z.object({
    id: z.string().min(1),
    label: z.string().min(1),
    description: z.string().min(1)
  })).min(1),
  ratingScale: z.array(z.any()).min(2),
  primaryQuestions: z.array(draftQuestionSchema).min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  approvedAt: z.string().nullable(),
  publishedAt: z.string().nullable(),
  publishedPath: z.string().nullable(),
  generationNotes: z.array(z.string()).default([])
});

const defaultRatingScale = [
  ['unsatisfactory', 'Unsatisfactory', 0, 'Performance consistently falls materially short of expectations.', 'strong'],
  ['needs_improvement', 'Needs Improvement', 1, 'Performance has meaningful gaps and requires focused improvement.', 'moderate'],
  ['meets_expectations', 'Meets Expectations', 2, 'Performance reliably fulfills the expectations of the role.', 'moderate'],
  ['exceeds_expectations', 'Exceeds Expectations', 3, 'Performance frequently surpasses normal expectations.', 'strong'],
  ['outstanding', 'Outstanding', 4, 'Performance significantly and consistently surpasses expectations.', 'strong']
].map(([id, label, score, stance, evidenceStrength]) => ({
  id,
  label,
  score,
  responseProfile: { stance, evidenceStrength, evidenceMix: ['quantitative', 'qualitative'] }
}));

export async function generateTopicDraft({ rootDir, fileName, fileBase64, caseType, description, actors, terms, ratingScale }) {
  const draftId = `${slugify(caseType)}-${Date.now()}`;
  const draftDir = path.join(rootDir, 'topic-drafts');
  const sourceDir = path.join(draftDir, 'sources');
  await fs.mkdir(sourceDir, { recursive: true });

  const safeFileName = `${draftId}.docx`;
  const sourcePath = path.join(sourceDir, safeFileName);
  await fs.writeFile(sourcePath, Buffer.from(fileBase64, 'base64'));
  let extracted;
  let suggestions;
  const suppliedTerms = normalizeTerms(terms);
  try {
    extracted = await extractTopicDocx(sourcePath);
    if (!extracted.plainText?.trim()) throw new Error('The uploaded Word document did not contain readable text.');
    suggestions = await suggestTopicDefinition({
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL ?? 'gpt-4.1-mini',
      caseType,
      description,
      terms: suppliedTerms,
      sourceText: extracted.plainText
    });
  } catch (error) {
    await fs.rm(sourcePath, { force: true });
    throw error;
  }

  const finalTerms = normalizeSuggestedTerms(suppliedTerms.length ? suppliedTerms : suggestions.terms);
  const termIds = new Set(finalTerms.map((term) => term.id));
  const questions = normalizeQuestions(suggestions.primaryQuestions, finalTerms, termIds);
  const now = new Date().toISOString();
  const extractPath = path.join(sourceDir, `${draftId}.extracted.json`);
  await fs.writeFile(extractPath, `${JSON.stringify(extracted, null, 2)}\n`, 'utf8');

  const draft = topicDraftSchema.parse({
    schemaVersion: 1,
    id: draftId,
    status: 'draft',
    topicId: slugify(caseType).replaceAll('-', '_'),
    caseType: String(caseType).trim(),
    description: String(description || `High-quality answer criteria for ${caseType}.`).trim(),
    sourceFileName: path.basename(fileName),
    sourceExtractPath: relativePath(rootDir, extractPath),
    workflow: {
      actors: actors?.length ? actors : ['requestor', 'participant'],
      factStatementLabel: 'Confident Fact',
      postProcessingTimeoutMs: 420000
    },
    terms: finalTerms,
    ratingScale: Array.isArray(ratingScale) && ratingScale.length ? ratingScale : defaultRatingScale,
    primaryQuestions: questions,
    createdAt: now,
    updatedAt: now,
    approvedAt: null,
    publishedAt: null,
    publishedPath: null,
    generationNotes: [
      'Questions, criteria, and term mappings were generated as a draft and require human approval.',
      `Extracted ${extracted.blocks.length} source blocks from ${path.basename(fileName)}.`
    ]
  });
  await writeDraft(rootDir, draft);
  return draft;
}

export async function listTopicDrafts(rootDir) {
  const draftDir = path.join(rootDir, 'topic-drafts');
  await fs.mkdir(draftDir, { recursive: true });
  const entries = await fs.readdir(draftDir, { withFileTypes: true });
  const drafts = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const draft = topicDraftSchema.parse(JSON.parse(await fs.readFile(path.join(draftDir, entry.name), 'utf8')));
    drafts.push(draft);
  }
  return drafts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function readTopicDraft(rootDir, id) {
  return topicDraftSchema.parse(JSON.parse(await fs.readFile(draftPath(rootDir, id), 'utf8')));
}

export async function saveTopicDraft(rootDir, input) {
  const current = await readTopicDraft(rootDir, input.id);
  if (current.status === 'published') throw new Error('Published topic drafts are read-only. Create an editable copy to make changes.');
  const draft = topicDraftSchema.parse({
    ...input,
    createdAt: current.createdAt,
    updatedAt: new Date().toISOString(),
    approvedAt: null,
    status: 'draft',
    publishedAt: null,
    publishedPath: null
  });
  validateDraftReferences(draft);
  await writeDraft(rootDir, draft);
  return draft;
}

export async function approveAndPublishTopicDraft(rootDir, input) {
  const saved = await saveTopicDraft(rootDir, input);
  const topic = buildPublishedTopic(saved);
  topicDefinitionSchema.parse(topic);
  const fileName = `${slugify(topic.caseType)}.json`;
  const outputPath = path.join(rootDir, 'config', 'case-types', fileName);
  const existing = await exists(outputPath);
  if (existing) throw new Error(`A published topic named ${topic.caseType} already exists. Rename the draft before publishing.`);
  await fs.writeFile(outputPath, `${JSON.stringify(topic, null, 2)}\n`, 'utf8');

  const now = new Date().toISOString();
  const published = topicDraftSchema.parse({
    ...saved,
    status: 'published',
    updatedAt: now,
    approvedAt: now,
    publishedAt: now,
    publishedPath: relativePath(rootDir, outputPath)
  });
  await writeDraft(rootDir, published);
  return { draft: published, topic, publishedPath: published.publishedPath };
}

export function buildPublishedTopic(draft) {
  const topicSlug = slugify(draft.caseType).replaceAll('-', '_');
  return {
    schemaVersion: 2,
    topicId: draft.topicId || topicSlug,
    caseType: draft.caseType,
    description: draft.description,
    workflow: draft.workflow,
    terms: draft.terms,
    ratingScale: draft.ratingScale,
    primaryQuestions: draft.primaryQuestions.map((question, questionIndex) => ({
      id: `${topicSlug}_q${questionIndex + 1}_${slugify(question.discussionArea).replaceAll('-', '_')}`,
      discussionArea: question.discussionArea,
      question: question.question,
      primaryTermId: question.primaryTermId,
      answerGuidance: question.answerGuidance,
      highQualityCriteria: question.highQualityCriteria.map((criterion, criterionIndex) => ({
        id: `${topicSlug}_q${questionIndex + 1}_${slugify(question.discussionArea).replaceAll('-', '_')}_criterion_${criterionIndex + 1}`,
        requirement: criterion.requirement,
        required: criterion.required,
        label: draft.caseType,
        termIds: criterion.termIds
      })),
      voluntaryCoverageRequirement: question.voluntaryCoverageRequirement
    }))
  };
}

function validateDraftReferences(draft) {
  const termIds = new Set(draft.terms.map((term) => term.id));
  for (const question of draft.primaryQuestions) {
    if (!termIds.has(question.primaryTermId)) throw new Error(`Unknown primary term ${question.primaryTermId} for ${question.discussionArea}.`);
    for (const criterion of question.highQualityCriteria) {
      for (const termId of criterion.termIds) {
        if (!termIds.has(termId)) throw new Error(`Unknown criterion term ${termId} for ${question.discussionArea}.`);
      }
    }
  }
}

async function suggestTopicDefinition({ apiKey, model, caseType, description, terms, sourceText }) {
  if (!apiKey) throw new Error('OPENAI_API_KEY is required to generate a topic draft.');
  const requestBody = JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      temperature: 0.1,
      max_tokens: 12000,
      messages: [
        {
          role: 'system',
          content: [
            'Convert a source document into a draft Common Ground interview topic.',
            'Return JSON only with keys terms and primaryQuestions.',
            'Each primary question needs discussionArea, question, answerGuidance, primaryTermId, voluntaryCoverageRequirement, and highQualityCriteria.',
            'Each criterion needs requirement, required, and termIds.',
            'Preserve every primary question and distinguish mandatory criteria (required true) from optional criteria (required false).',
            'Use concise criterion requirements. Map every criterion to one or more supplied or proposed terms.',
            'Do not invent domain-specific questions that are absent from the source.'
          ].join(' ')
        },
        {
          role: 'user',
          content: JSON.stringify({
            caseType,
            description,
            suppliedTerms: terms,
            sourceDocument: sourceText.slice(0, 100000)
          })
        }
      ]
  });
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetchWithDeadline('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: requestBody
      }, openAiRequestTimeoutMs());
      if (!response.ok) {
        const error = new Error(`Topic draft generation failed: ${response.status} ${await response.text()}`);
        if (attempt < 3 && (response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500)) {
          lastError = error;
          await delay(750 * attempt);
          continue;
        }
        throw error;
      }
      const data = await response.json();
      const text = data.choices?.[0]?.message?.content;
      if (!text) throw new Error('Topic draft generation returned no content.');
      return JSON.parse(text);
    } catch (error) {
      lastError = error;
      if (attempt >= 3 || !/fetch failed|network|socket|timeout|timed out|aborted|econnreset|etimedout|enotfound|eai_again/i.test(error.message)) throw error;
      await delay(750 * attempt);
    }
  }
  throw new Error(`Topic draft generation failed after retries: ${lastError?.message ?? 'unknown error'}`);
}

function normalizeTerms(terms) {
  if (!Array.isArray(terms)) return [];
  return terms.filter((term) => term?.label && term?.description).map((term) => ({
    id: slugify(term.id || term.label).replaceAll('-', '_'),
    label: String(term.label).trim(),
    description: String(term.description).trim()
  }));
}

function normalizeSuggestedTerms(terms) {
  const normalized = normalizeTerms(terms);
  if (!normalized.length) throw new Error('The generated draft did not contain usable topic terms.');
  return normalized;
}

function normalizeQuestions(questions, terms, termIds) {
  if (!Array.isArray(questions) || !questions.length) throw new Error('The generated draft did not contain primary questions.');
  const fallbackTerm = terms[0].id;
  return questions.map((question) => {
    const primaryTermId = termIds.has(question.primaryTermId) ? question.primaryTermId : fallbackTerm;
    return {
      discussionArea: String(question.discussionArea || 'Discussion Area').trim(),
      question: String(question.question || '').trim(),
      answerGuidance: Array.isArray(question.answerGuidance) ? question.answerGuidance.map(String).map((item) => item.trim()).filter(Boolean) : [],
      primaryTermId,
      voluntaryCoverageRequirement: String(question.voluntaryCoverageRequirement || '50%'),
      highQualityCriteria: Array.isArray(question.highQualityCriteria) ? question.highQualityCriteria.map((criterion) => ({
        requirement: String(criterion.requirement || '').trim(),
        required: Boolean(criterion.required),
        termIds: (Array.isArray(criterion.termIds) ? criterion.termIds : [primaryTermId]).filter((termId) => termIds.has(termId))
      })).filter((criterion) => criterion.requirement).map((criterion) => ({
        ...criterion,
        termIds: criterion.termIds.length ? criterion.termIds : [primaryTermId]
      })) : []
    };
  });
}

export async function extractTopicDocx(sourcePath) {
  const archive = await fs.readFile(sourcePath);
  const documentXml = readZipEntry(archive, 'word/document.xml').toString('utf8');
  const paragraphs = [...documentXml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)]
    .map((match) => [...match[1].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((textMatch) => decodeXml(textMatch[1])).join(''))
    .map((text) => text.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return {
    fileName: path.basename(sourcePath),
    blocks: paragraphs.map((text) => ({ type: 'paragraph', text })),
    plainText: paragraphs.join('\n')
  };
}

function readZipEntry(archive, entryName) {
  const eocdSignature = 0x06054b50;
  let eocdOffset = -1;
  for (let offset = archive.length - 22; offset >= Math.max(0, archive.length - 65557); offset -= 1) {
    if (archive.readUInt32LE(offset) === eocdSignature) { eocdOffset = offset; break; }
  }
  if (eocdOffset < 0) throw new Error('The uploaded file is not a readable .docx archive.');
  const centralDirectoryOffset = archive.readUInt32LE(eocdOffset + 16);
  const entryCount = archive.readUInt16LE(eocdOffset + 10);
  let offset = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (archive.readUInt32LE(offset) !== 0x02014b50) throw new Error('The Word archive central directory is invalid.');
    const compressionMethod = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const fileNameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localHeaderOffset = archive.readUInt32LE(offset + 42);
    const name = archive.subarray(offset + 46, offset + 46 + fileNameLength).toString('utf8');
    if (name === entryName) {
      if (archive.readUInt32LE(localHeaderOffset) !== 0x04034b50) throw new Error('The Word document entry header is invalid.');
      const localNameLength = archive.readUInt16LE(localHeaderOffset + 26);
      const localExtraLength = archive.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
      const compressed = archive.subarray(dataStart, dataStart + compressedSize);
      if (compressionMethod === 0) return compressed;
      if (compressionMethod === 8) return inflateRawSync(compressed);
      throw new Error(`Unsupported Word archive compression method: ${compressionMethod}`);
    }
    offset += 46 + fileNameLength + extraLength + commentLength;
  }
  throw new Error('The uploaded archive does not contain word/document.xml.');
}

function decodeXml(value) {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

async function writeDraft(rootDir, draft) {
  await fs.mkdir(path.join(rootDir, 'topic-drafts'), { recursive: true });
  await fs.writeFile(draftPath(rootDir, draft.id), `${JSON.stringify(draft, null, 2)}\n`, 'utf8');
}

function draftPath(rootDir, id) {
  return path.join(rootDir, 'topic-drafts', `${safeId(id)}.json`);
}

function safeId(value) {
  const id = String(value || '');
  if (!/^[a-z0-9-]+$/i.test(id)) throw new Error('Invalid topic draft ID.');
  return id;
}

function slugify(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function relativePath(rootDir, value) {
  return path.relative(rootDir, value).replaceAll('\\', '/');
}

async function exists(filePath) {
  try { await fs.access(filePath); return true; } catch { return false; }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithDeadline(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`OpenAI request timed out after ${timeoutMs} ms.`)), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`OpenAI request timed out after ${timeoutMs} ms.`, { cause: error });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function openAiRequestTimeoutMs() {
  const configured = Number(process.env.OPENAI_REQUEST_TIMEOUT_MS ?? 60000);
  return Number.isFinite(configured) ? Math.max(5000, configured) : 60000;
}
