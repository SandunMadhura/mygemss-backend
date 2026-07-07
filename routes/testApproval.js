const express = require('express');
const router = express.Router();
const { GoogleGenerativeAI } = require('@google/generative-ai');

const TestPost = require('../models/TestPost');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Convert a public image URL to the inline-data format expected by Gemini's
 * vision API (base64-encoded bytes + MIME type).
 *
 * Supported MIME types: image/jpeg, image/png, image/webp, image/gif
 */
async function urlToGenerativePart(imageUrl) {
  const response = await fetch(imageUrl);

  if (!response.ok) {
    throw new Error(
      `Failed to fetch image from URL (${response.status}): ${imageUrl}`
    );
  }

  const contentType = response.headers.get('content-type') || 'image/jpeg';
  // Strip any charset or extra params (e.g. "image/jpeg; charset=utf-8")
  const mimeType = contentType.split(';')[0].trim();

  const arrayBuffer = await response.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString('base64');

  return { inlineData: { data: base64, mimeType } };
}

/**
 * Strip Markdown code-fences that Gemini sometimes wraps around its JSON
 * response so that JSON.parse() does not choke.
 * e.g.  ```json\n{...}\n```  →  {...}
 */
function stripCodeFence(text) {
  return text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
}

// ─── The AI Content-Moderation Prompt ────────────────────────────────────────

const MODERATION_PROMPT =
  'You are an AI content moderator for a gem and jewelry marketplace. ' +
  'Analyze the provided text and image. ' +
  'If the content is related to gemstones, jewelry, lapidary, or minerals, ' +
  'reply ONLY with a valid JSON: {"isGemRelated": true, "confidence": <number between 0-100>}. ' +
  'If not, reply ONLY with: {"isGemRelated": false, "confidence": <number between 0-100>}.';

// ─── Route: POST /api/test-approval ──────────────────────────────────────────

/**
 * @route   POST /api/test-approval
 * @desc    Analyse a post with Gemini and auto-approve if it is gem-related
 *          with high confidence (> 80). Saves the result to the TestPost
 *          collection and returns the saved document.
 * @access  Public (add auth middleware as needed)
 *
 * Body:
 *   description {string}  – text content of the post
 *   imageUrl    {string}  – publicly-accessible image URL
 */
router.post('/test-approval', async (req, res) => {
  const { description, imageUrl } = req.body;

  // ── 1. Basic input validation ──────────────────────────────────────────────
  if (!description || typeof description !== 'string' || !description.trim()) {
    return res
      .status(400)
      .json({ success: false, error: '`description` is required and must be a non-empty string.' });
  }

  if (!imageUrl || typeof imageUrl !== 'string' || !imageUrl.trim()) {
    return res
      .status(400)
      .json({ success: false, error: '`imageUrl` is required and must be a non-empty string.' });
  }

  // ── 2. Initialise Gemini client ────────────────────────────────────────────
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('[test-approval] GEMINI_API_KEY is not set in .env');
    return res
      .status(500)
      .json({ success: false, error: 'Server misconfiguration: Gemini API key is missing.' });
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

  // ── 3. Fetch the image and build the multimodal request ───────────────────
  let imagePart;
  try {
    imagePart = await urlToGenerativePart(imageUrl.trim());
  } catch (fetchErr) {
    console.error('[test-approval] Image fetch error:', fetchErr.message);
    return res
      .status(400)
      .json({ success: false, error: `Could not retrieve image: ${fetchErr.message}` });
  }

  // ── 4. Call Gemini ─────────────────────────────────────────────────────────
  let geminiResult;
  try {
    const result = await model.generateContent([
      MODERATION_PROMPT,
      `Post description: "${description.trim()}"`,
      imagePart,
    ]);

    const rawText = result.response.text();
    const cleanText = stripCodeFence(rawText);

    console.log('[test-approval] Gemini raw response:', rawText);

    geminiResult = JSON.parse(cleanText);
  } catch (aiErr) {
    console.error('[test-approval] Gemini error:', aiErr.message);
    return res
      .status(502)
      .json({ success: false, error: `AI moderation failed: ${aiErr.message}` });
  }

  // ── 5. Validate Gemini's parsed response ───────────────────────────────────
  const { isGemRelated, confidence } = geminiResult;

  if (typeof isGemRelated !== 'boolean' || typeof confidence !== 'number') {
    console.error('[test-approval] Unexpected Gemini response shape:', geminiResult);
    return res
      .status(502)
      .json({ success: false, error: 'Unexpected response format from AI moderator.' });
  }

  // ── 6. Determine approval status ──────────────────────────────────────────
  //  Approved  →  gem-related AND confidence > 80
  //  Pending   →  anything else (borderline, off-topic, low confidence)
  const status = isGemRelated && confidence > 80 ? 'approved' : 'pending';

  // ── 7. Persist to MongoDB ──────────────────────────────────────────────────
  try {
    const testPost = new TestPost({
      description: description.trim(),
      imageUrl: imageUrl.trim(),
      status,
      ai_confidence: confidence,
    });

    const saved = await testPost.save();

    return res.status(201).json({
      success: true,
      data: saved,
      ai_analysis: {
        isGemRelated,
        confidence,
        verdict: status,
      },
    });
  } catch (dbErr) {
    console.error('[test-approval] DB save error:', dbErr.message);
    return res
      .status(500)
      .json({ success: false, error: `Database error: ${dbErr.message}` });
  }
});

module.exports = router;
