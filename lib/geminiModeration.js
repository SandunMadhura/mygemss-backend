/**
 * geminiModeration.js
 *
 * Reusable Gemini AI content-moderation utility for MyGemss.
 *
 * Supports all three post types:
 *   • Text only   → Gemini analyses the description text alone
 *   • Image only  → Gemini analyses the image visually
 *   • Text + image → Gemini analyses both together (most accurate)
 *
 * Returns: { isGemRelated: boolean, confidence: number (0-100) }
 * Throws on network or parse errors — callers should catch.
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');

// ── Prompt ────────────────────────────────────────────────────────────────────
const MODERATION_PROMPT =
  'You are an AI content moderator for a gem and jewelry marketplace called MyGemss. ' +
  'Analyze the provided content (text and/or image). ' +
  'If the content is related to gemstones, jewelry, lapidary, minerals, crystals, or precious stones, ' +
  'reply ONLY with a valid JSON object: {"isGemRelated": true, "confidence": <number between 0-100>}. ' +
  'If the content is NOT related to those topics, ' +
  'reply ONLY with: {"isGemRelated": false, "confidence": <number between 0-100>}. ' +
  'Do NOT include any explanation, markdown, or extra text — only the raw JSON.';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Fetch a public image URL and convert it to a Gemini inline-data part.
 */
async function urlToInlinePart(imageUrl) {
  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`Image fetch failed (${response.status}): ${imageUrl}`);
  }
  const contentType = response.headers.get('content-type') || 'image/jpeg';
  const mimeType = contentType.split(';')[0].trim();
  const buffer = await response.arrayBuffer();
  const base64 = Buffer.from(buffer).toString('base64');
  return { inlineData: { data: base64, mimeType } };
}

/**
 * Strip markdown code-fences Gemini sometimes wraps around JSON output.
 * e.g.  ```json\n{...}\n```  →  {...}
 */
function stripCodeFence(text) {
  return text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * analyzePostWithAI
 *
 * @param {string} content   - The post text (may be empty string)
 * @param {string[]} mediaUrls - Array of Cloudinary image URLs (may be empty)
 * @returns {Promise<{ isGemRelated: boolean, confidence: number }>}
 */
async function analyzePostWithAI(content = '', mediaUrls = []) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

  // Build the parts array dynamically based on what content exists
  const parts = [MODERATION_PROMPT];

  const trimmedText = (content || '').trim();
  if (trimmedText) {
    parts.push(`Post description: "${trimmedText}"`);
  }

  // Attach image parts — skip non-image media (videos, etc.)
  const IMAGE_MIME_RE = /\.(jpg|jpeg|png|webp|gif)(\?.*)?$/i;
  const imageUrls = (mediaUrls || []).filter(u => IMAGE_MIME_RE.test(u) || u.includes('image'));

  for (const imageUrl of imageUrls) {
    try {
      const part = await urlToInlinePart(imageUrl);
      parts.push(part);
    } catch (fetchErr) {
      // Log but continue — if only some images fail, still analyse the rest
      console.warn('[geminiModeration] Skipping image (fetch failed):', fetchErr.message);
    }
  }

  // Edge case: no usable content at all
  if (parts.length === 1) {
    console.warn('[geminiModeration] No text or images to analyse — defaulting to pending');
    return { isGemRelated: false, confidence: 0 };
  }

  const result = await model.generateContent(parts);
  const rawText = result.response.text();
  const cleanText = stripCodeFence(rawText);

  console.log('[geminiModeration] Raw response:', rawText);

  const parsed = JSON.parse(cleanText);

  if (typeof parsed.isGemRelated !== 'boolean' || typeof parsed.confidence !== 'number') {
    throw new Error(`Unexpected Gemini response shape: ${rawText}`);
  }

  return { isGemRelated: parsed.isGemRelated, confidence: parsed.confidence };
}

module.exports = { analyzePostWithAI };
