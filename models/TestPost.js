const mongoose = require('mongoose');

/**
 * TestPost – used by the AI-powered approval endpoint (/api/test-approval).
 * The AI moderator analyses `description` + `imageUrl` via Gemini and writes
 * its verdict into `status` and `ai_confidence`.
 */
const TestPostSchema = new mongoose.Schema(
  {
    description: {
      type: String,
      required: true,
      trim: true,
    },

    imageUrl: {
      type: String,
      required: true,
      trim: true,
    },

    status: {
      type: String,
      enum: ['approved', 'pending', 'rejected'],
      default: 'pending',
    },

    ai_confidence: {
      type: Number,
      min: 0,
      max: 100,
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('TestPost', TestPostSchema);
