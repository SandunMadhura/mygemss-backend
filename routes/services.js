const express = require('express');
const router  = express.Router();
const { ClerkExpressRequireAuth } = require('@clerk/clerk-sdk-node');
const Service = require('../models/Service');
const User    = require('../models/User');
const { upload } = require('../config/cloudinary');

// ─── Middleware: resolve DB user from Clerk token ────────────────────────────
async function resolveUser(req, res, next) {
  try {
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) return res.status(404).json({ error: 'User not found' });
    req.dbUser = user;
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/services  → submit a new service listing (authenticated)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', ClerkExpressRequireAuth({}), resolveUser, upload.single('image'), async (req, res) => {
  try {
    const { serviceName, category, address, shortDescription, contactNumber } = req.body;

    if (!serviceName || !category || !address || !shortDescription || !contactNumber) {
      return res.status(400).json({ error: 'All required fields must be filled' });
    }

    const service = new Service({
      providerId:       req.dbUser._id,
      serviceName,
      category,
      address,
      shortDescription,
      contactNumber,
      serviceImageUrl:  req.file ? req.file.path : '',
      status: 'pending',
    });

    await service.save();
    res.status(201).json(service);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/services/my  → get services owned by the current user
// ─────────────────────────────────────────────────────────────────────────────
router.get('/my', ClerkExpressRequireAuth({}), resolveUser, async (req, res) => {
  try {
    const services = await Service.find({ providerId: req.dbUser._id }).sort({ createdAt: -1 });
    res.json(services);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/services/:id  → get a specific service
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const service = await Service.findById(req.params.id)
      .populate('providerId', 'firstName lastName profileImageUrl');
    if (!service) return res.status(404).json({ error: 'Service not found' });
    res.json(service);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/services  → list ALL approved services (public)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { category } = req.query;
    const filter = { status: 'approved' };
    if (category && category !== 'All') filter.category = category;

    const services = await Service.find(filter)
      .populate('providerId', 'firstName lastName profileImageUrl')
      .sort({ createdAt: -1 });

    res.json(services);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/services/:id  → update an existing service listing (authenticated)
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/:id', ClerkExpressRequireAuth({}), resolveUser, upload.single('image'), async (req, res) => {
  try {
    const service = await Service.findById(req.params.id);
    if (!service) return res.status(404).json({ error: 'Service not found' });
    
    // Check ownership
    if (service.providerId.toString() !== req.dbUser._id.toString()) {
      return res.status(403).json({ error: 'Not authorized to edit this service' });
    }

    const { serviceName, category, address, shortDescription, contactNumber } = req.body;

    if (serviceName) service.serviceName = serviceName;
    if (category) service.category = category;
    if (address) service.address = address;
    if (shortDescription) service.shortDescription = shortDescription;
    if (contactNumber) service.contactNumber = contactNumber;
    
    if (req.file) {
      service.serviceImageUrl = req.file.path;
    }

    // Reset status to pending upon edit so admin can re-approve
    service.status = 'pending';

    await service.save();
    res.json(service);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
