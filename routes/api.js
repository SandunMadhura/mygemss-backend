const express = require('express');
const router = express.Router();
const { ClerkExpressRequireAuth } = require('@clerk/clerk-sdk-node');
const User = require('../models/User');
const Store = require('../models/Store');
const Post = require('../models/Post');
const Message = require('../models/Message');
const { upload } = require('../config/cloudinary');
const { analyzePostWithAI } = require('../lib/geminiModeration');

// ─── Health Check ─────────────────────────────────────────────────────────────
router.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'API is running' });
});

// ─── User Sync (Clerk → MongoDB) ──────────────────────────────────────────────
router.post('/users/sync', ClerkExpressRequireAuth({}), async (req, res) => {
  try {
    const clerkId = req.auth.userId;
    const { email, firstName, lastName, profileImageUrl, bio } = req.body;

    let user = await User.findOne({ clerkId });
    if (!user) {
      user = new User({ clerkId, email, firstName, lastName, profileImageUrl, bio, role: 'normal' });
      await user.save();
    } else {
      // Update mutable fields on re-sync
      user.email = email || user.email;
      user.firstName = firstName || user.firstName;
      user.lastName = lastName || user.lastName;
      user.profileImageUrl = profileImageUrl || user.profileImageUrl;
      if (bio !== undefined) user.bio = bio;
      await user.save();
    }

    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Get User Profile ─────────────────────────────────────────────────────────
router.get('/users/me', ClerkExpressRequireAuth({}), async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Update Bio ──────────────────────────────────────────────────────────────────
router.patch('/users/me/bio', ClerkExpressRequireAuth({}), async (req, res) => {
  try {
    const user = await User.findOneAndUpdate(
      { clerkId: req.auth.userId },
      { bio: req.body.bio },
      { new: true }
    );
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Update Full Profile (name, bio, avatar via Cloudinary) ────────────────────────
router.put('/users/profile', ClerkExpressRequireAuth({}), upload.single('avatar'), async (req, res) => {
  try {
    const updates = {};
    if (req.body.firstName) updates.firstName = req.body.firstName;
    if (req.body.lastName  !== undefined) updates.lastName  = req.body.lastName;
    if (req.body.bio       !== undefined) updates.bio       = req.body.bio;
    if (req.file) updates.profileImageUrl = req.file.path;  // Cloudinary URL

    const user = await User.findOneAndUpdate(
      { clerkId: req.auth.userId },
      updates,
      { new: true }
    );
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Get a user by MongoDB _id (for Profile Quick View) ────────────────────────────
router.get('/users/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('firstName lastName profileImageUrl bio role');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Social Feed – GET (infinite scroll with cursor pagination) ──────────────────
router.get('/posts', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const cursor = req.query.cursor;

    const query = {
      status: { $in: ['approved', null, undefined] },
      ...(cursor ? { createdAt: { $lt: new Date(cursor) } } : {})
    };

    const posts = await Post.find(query)
      .populate('author', 'firstName lastName profileImageUrl role')
      .populate('comments.user', 'firstName lastName profileImageUrl')
      .sort({ createdAt: -1 })
      .limit(limit + 1);

    const hasNextPage = posts.length > limit;
    if (hasNextPage) posts.pop();

    const nextCursor = hasNextPage ? posts[posts.length - 1].createdAt.toISOString() : null;
    res.json({ posts, nextCursor });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// ─── Social Feed – POST (create post with optional media upload) ───────────────
router.post('/posts', ClerkExpressRequireAuth({}), upload.array('media', 5), async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) return res.status(404).json({ error: 'User not found. Please sync your profile first.' });

    const mediaUrls = req.files ? req.files.map(f => f.path) : [];

    const post = new Post({
      author: user._id,
      content: req.body.content || '',
      mediaUrls,
      status: 'pending',
      ai_reviewed: false,
    });

    await post.save();
    await post.populate('author', 'firstName lastName profileImageUrl role');

    // ── Respond immediately so the client gets instant feedback ───────────────
    res.status(201).json(post);

    // ── Background AI moderation (non-blocking) ────────────────────────────────
    setImmediate(async () => {
      try {
        console.log(`[AI] Analysing post ${post._id} …`);

        const { isGemRelated, confidence } = await analyzePostWithAI(
          post.content,
          post.mediaUrls
        );

        const newStatus = (isGemRelated && confidence > 80) ? 'approved' : 'pending';

        const updated = await Post.findByIdAndUpdate(
          post._id,
          { status: newStatus, ai_confidence: confidence, ai_reviewed: true },
          { new: true }
        ).populate('author', 'firstName lastName profileImageUrl role');

        console.log(`[AI] Post ${post._id} → ${newStatus} (confidence: ${confidence}%)`);

        const { io } = require('../server');
        const authorId = updated.author?._id?.toString();

        if (newStatus === 'approved') {
          // Broadcast to all feed clients
          io.emit('post_approved', updated);
          // Targeted: notify the author their post is live
          if (authorId) {
            io.emit('post_approved_owner', {
              targetUserId: authorId,
              postId: post._id,
            });
          }
        } else {
          // AI flagged it for manual review — notify the author
          if (authorId) {
            io.emit('post_flagged', {
              targetUserId: authorId,
              postId: post._id,
              confidence,
            });
          }
        }
      } catch (aiErr) {
        // AI failure is non-fatal — post stays 'pending' for admin review
        console.error(`[AI] Moderation failed for post ${post._id}:`, aiErr.message);
        await Post.findByIdAndUpdate(post._id, { ai_reviewed: false });
      }
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// ─── Like / Unlike a Post ─────────────────────────────────────────────────────
router.patch('/posts/:id/like', ClerkExpressRequireAuth({}), async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const post = await Post.findById(req.params.id).populate('author', '_id');
    if (!post) return res.status(404).json({ error: 'Post not found' });

    const alreadyLiked = post.likes.includes(user._id);
    if (alreadyLiked) {
      post.likes.pull(user._id);
    } else {
      post.likes.push(user._id);
    }
    await post.save();
    res.json({ likes: post.likes.length, liked: !alreadyLiked });

    // Notify post owner when someone LIKES (not when unliking, and not self-like)
    const postOwnerId = post.author?._id?.toString();
    const likerId    = user._id.toString();
    if (!alreadyLiked && postOwnerId && postOwnerId !== likerId) {
      const { io } = require('../server');
      io.emit('post_liked', {
        targetUserId: postOwnerId,
        likerName: `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'Someone',
      });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Comment on a Post ────────────────────────────────────────────────────────
router.post('/posts/:id/comment', ClerkExpressRequireAuth({}), async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const post = await Post.findById(req.params.id).populate('author', '_id');
    if (!post) return res.status(404).json({ error: 'Post not found' });

    post.comments.push({ user: user._id, text: req.body.text });
    await post.save();
    await post.populate('comments.user', 'firstName lastName profileImageUrl');
    const newComment = post.comments[post.comments.length - 1];
    res.json(newComment);

    // Notify post owner when someone comments (not self-comment)
    const postOwnerId  = post.author?._id?.toString();
    const commenterId  = user._id.toString();
    if (postOwnerId && postOwnerId !== commenterId) {
      const { io } = require('../server');
      io.emit('post_commented', {
        targetUserId: postOwnerId,
        commenterName: `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'Someone',
        preview: (req.body.text || '').slice(0, 60),
      });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Stores ───────────────────────────────────────────────────────────────────
router.get('/stores', async (req, res) => {
  try {
    const { category } = req.query;
    const filter = { status: 'approved' };
    if (category) filter.category = category;
    const stores = await Store.find(filter).populate('owner', 'firstName lastName profileImageUrl');
    res.json(stores);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET my stores
router.get('/stores/my', ClerkExpressRequireAuth({}), async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const stores = await Store.find({ owner: user._id }).sort({ createdAt: -1 });
    res.json(stores);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST apply for store
router.post('/stores/apply', ClerkExpressRequireAuth({}), upload.fields([
  { name: 'identityProof', maxCount: 1 },
  { name: 'coverImage',    maxCount: 1 },
]), async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const existing = await Store.findOne({ owner: user._id });
    if (existing) return res.status(400).json({ error: 'You already have a store application.' });

    const identityProofUrl = req.files?.identityProof?.[0]?.path;
    const coverImageUrl    = req.files?.coverImage?.[0]?.path;

    const store = new Store({
      owner: user._id,
      name: req.body.name,
      description: req.body.description,
      location: req.body.location,
      category: req.body.category,
      identityProofUrl,
      coverImageUrl,
      contactOptions: {
        phone: req.body.phone || '',
        chatEnabled: true
      }
    });

    await store.save();
    res.status(201).json(store);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PATCH edit my store  (handles logo + coverImage uploads)
router.patch('/stores/my/:id', ClerkExpressRequireAuth({}), upload.fields([
  { name: 'logo',        maxCount: 1 },
  { name: 'coverImage',  maxCount: 1 },
]), async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const store = await Store.findOne({ _id: req.params.id, owner: user._id });
    if (!store) return res.status(404).json({ error: 'Store not found' });

    if (req.body.name)                store.name        = req.body.name;
    if (req.body.description !== undefined) store.description = req.body.description;
    if (req.body.location    !== undefined) store.location    = req.body.location;
    if (req.body.phone       !== undefined) {
      if (!store.contactOptions) store.contactOptions = {};
      store.contactOptions.phone = req.body.phone;
    }
    if (req.files?.logo?.[0])        store.logoUrl       = req.files.logo[0].path;
    if (req.files?.coverImage?.[0])  store.coverImageUrl = req.files.coverImage[0].path;

    await store.save();
    res.json(store);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE my store (for re-applying after rejection)
router.delete('/stores/my/:id', ClerkExpressRequireAuth({}), async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const store = await Store.findOneAndDelete({ _id: req.params.id, owner: user._id });
    if (!store) return res.status(404).json({ error: 'Store not found' });

    res.json({ message: 'Store application deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
