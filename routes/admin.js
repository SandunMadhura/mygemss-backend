const express = require('express');
const router = express.Router();
const { ClerkExpressRequireAuth } = require('@clerk/clerk-sdk-node');
const Store   = require('../models/Store');
const User    = require('../models/User');
const Post    = require('../models/Post');
const Ad      = require('../models/Ad');
const Service = require('../models/Service');
const { upload } = require('../config/cloudinary');

// ─── Middleware: Ensure Admin ────────────────────────────────────────────────
async function requireAdmin(req, res, next) {
  try {
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied. Admin role required.' });
    }
    req.dbUser = user;
    next();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

// ═══════════════════════════════════════════════════════════
// STORE MANAGEMENT
// ═══════════════════════════════════════════════════════════

// GET all stores
router.get('/stores', ClerkExpressRequireAuth({}), requireAdmin, async (req, res) => {
  try {
    const stores = await Store.find()
      .populate('owner', 'firstName lastName profileImageUrl email')
      .sort({ createdAt: -1 });
    res.json(stores);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PATCH store status (approve / reject / suspend)
router.patch('/stores/:id/status', ClerkExpressRequireAuth({}), requireAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    if (!['pending', 'approved', 'rejected', 'suspended'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    const store = await Store.findByIdAndUpdate(req.params.id, { status }, { new: true })
      .populate('owner', 'firstName lastName profileImageUrl email');
    if (!store) return res.status(404).json({ error: 'Store not found' });

    // Emit targeted notification to the store owner
    const { io } = require('../server');
    const ownerMongoId = store.owner?._id?.toString();
    if (ownerMongoId) {
      const label = status === 'approved' ? 'approved' : status === 'rejected' ? 'rejected' : 'suspended';
      io.emit('store_status_changed', {
        targetUserId: ownerMongoId,
        storeName: store.name,
        status: label,
      });
    }

    res.json(store);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE store permanently
router.delete('/stores/:id', ClerkExpressRequireAuth({}), requireAdmin, async (req, res) => {
  try {
    const store = await Store.findByIdAndDelete(req.params.id);
    if (!store) return res.status(404).json({ error: 'Store not found' });
    res.json({ message: 'Store deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════
// POST MANAGEMENT
// ═══════════════════════════════════════════════════════════

// GET all posts (all statuses)
router.get('/posts', ClerkExpressRequireAuth({}), requireAdmin, async (req, res) => {
  try {
    const { status } = req.query; // optional filter: ?status=pending
    const filter = status ? { status } : {};
    const posts = await Post.find(filter)
      .populate('author', 'firstName lastName profileImageUrl role')
      .sort({ createdAt: -1 });
    res.json(posts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PATCH approve a post → also socket-emit to all feed clients
router.patch('/posts/:id/approve', ClerkExpressRequireAuth({}), requireAdmin, async (req, res) => {
  try {
    const post = await Post.findByIdAndUpdate(
      req.params.id,
      { status: 'approved' },
      { new: true }
    ).populate('author', 'firstName lastName profileImageUrl role');

    if (!post) return res.status(404).json({ error: 'Post not found' });

    // Emit real-time event to all connected feed clients
    const { io } = require('../server');
    io.emit('post_approved', post);

    // Notify the post author that their post is now live
    const authorId = post.author?._id?.toString();
    if (authorId) {
      io.emit('post_approved_owner', { targetUserId: authorId, postId: post._id });
    }

    res.json(post);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE post permanently
router.delete('/posts/:id', ClerkExpressRequireAuth({}), requireAdmin, async (req, res) => {
  try {
    const post = await Post.findByIdAndDelete(req.params.id);
    if (!post) return res.status(404).json({ error: 'Post not found' });
    res.json({ message: 'Post deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════
// USER MANAGEMENT
// ═══════════════════════════════════════════════════════════

// GET all users
router.get('/users', ClerkExpressRequireAuth({}), requireAdmin, async (req, res) => {
  try {
    const users = await User.find().sort({ createdAt: -1 });
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PATCH user role (grant/revoke admin)
router.patch('/users/:id/role', ClerkExpressRequireAuth({}), requireAdmin, async (req, res) => {
  try {
    const { role } = req.body;
    if (!['normal', 'seller', 'admin'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    const user = await User.findByIdAndUpdate(req.params.id, { role }, { new: true });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PATCH toggle block status
router.patch('/users/:id/block', ClerkExpressRequireAuth({}), requireAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.isBlocked = !user.isBlocked;
    await user.save();
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PATCH add warning
router.patch('/users/:id/warn', ClerkExpressRequireAuth({}), requireAdmin, async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { $inc: { warningCount: 1 } },
      { new: true }
    );
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════
// AD MANAGEMENT
// ═══════════════════════════════════════════════════════════

// GET all ads (public – no auth needed for feed slider)
router.get('/ads', async (req, res) => {
  try {
    const ads = await Ad.find().sort({ createdAt: -1 });
    res.json(ads);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST upload new ad (admin only)
router.post('/ads', ClerkExpressRequireAuth({}), requireAdmin, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Image file is required' });
    const ad = new Ad({
      imageUrl: req.file.path,
      title:    req.body.title || '',
      link:     req.body.link  || '',
    });
    await ad.save();
    res.status(201).json(ad);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE ad
router.delete('/ads/:id', ClerkExpressRequireAuth({}), requireAdmin, async (req, res) => {
  try {
    const ad = await Ad.findByIdAndDelete(req.params.id);
    if (!ad) return res.status(404).json({ error: 'Ad not found' });
    res.json({ message: 'Ad deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════
// SERVICE MANAGEMENT
// ═══════════════════════════════════════════════════════════

// GET all services (filter by status via ?status=pending)
router.get('/services', ClerkExpressRequireAuth({}), requireAdmin, async (req, res) => {
  try {
    const { status } = req.query;
    const filter = status ? { status } : {};
    const services = await Service.find(filter)
      .populate('providerId', 'firstName lastName profileImageUrl email')
      .sort({ createdAt: -1 });
    res.json(services);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH update service status (approve / reject)
router.patch('/services/:id/status', ClerkExpressRequireAuth({}), requireAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    if (!['pending', 'approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status value' });
    }
    const service = await Service.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    ).populate('providerId', 'firstName lastName profileImageUrl email');
    if (!service) return res.status(404).json({ error: 'Service not found' });

    // Emit targeted notification to the service provider
    const { io } = require('../server');
    const providerMongoId = service.providerId?._id?.toString();
    if (providerMongoId) {
      io.emit('service_status_changed', {
        targetUserId: providerMongoId,
        serviceName: service.name || service.businessName || 'your service',
        status,
      });
    }

    res.json(service);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE service permanently
router.delete('/services/:id', ClerkExpressRequireAuth({}), requireAdmin, async (req, res) => {
  try {
    const service = await Service.findByIdAndDelete(req.params.id);
    if (!service) return res.status(404).json({ error: 'Service not found' });
    res.json({ message: 'Service deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

