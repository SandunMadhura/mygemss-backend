const express = require('express');
const router = express.Router();
const { ClerkExpressRequireAuth } = require('@clerk/clerk-sdk-node');
const Product = require('../models/Product');
const Store = require('../models/Store');
const User = require('../models/User');
const { upload } = require('../config/cloudinary');

// ─── Helper: verify caller owns the store ─────────────────────────────────────
async function getSellerAndStore(clerkId, storeId, res) {
  const user = await User.findOne({ clerkId });
  if (!user) { res.status(404).json({ error: 'User not found. Sync your profile first.' }); return null; }

  const store = await Store.findOne({ _id: storeId, owner: user._id, status: 'approved' });
  if (!store) { res.status(403).json({ error: 'Store not found or not approved.' }); return null; }

  return { user, store };
}

// ─── GET /products  – public product listing with optional filters ─────────────
router.get('/', async (req, res) => {
  try {
    const { category, subCategory, storeId, q, page = 1 } = req.query;
    const limit = 12;
    const skip = (parseInt(page) - 1) * limit;

    const filter = { isActive: true };
    if (category)    filter.category    = category;
    if (subCategory) filter.subCategory = subCategory;
    if (storeId)     filter.store       = storeId;
    if (q)           filter.name        = { $regex: q, $options: 'i' };

    const [products, total] = await Promise.all([
      Product.find(filter)
        .populate('store', 'name contactOptions')
        .populate('seller', 'firstName lastName profileImageUrl')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Product.countDocuments(filter)
    ]);

    res.json({ products, total, pages: Math.ceil(total / limit), page: parseInt(page) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /products/:id  – single product detail ───────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const product = await Product.findById(req.params.id)
      .populate('store', 'name contactOptions category')
      .populate('seller', 'firstName lastName profileImageUrl');
    if (!product) return res.status(404).json({ error: 'Product not found' });
    res.json(product);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /products  – seller creates a product ───────────────────────────────
router.post('/', ClerkExpressRequireAuth({}), upload.array('images', 8), async (req, res) => {
  try {
    const ctx = await getSellerAndStore(req.auth.userId, req.body.storeId, res);
    if (!ctx) return;

    const images = req.files ? req.files.map(f => f.path) : [];

    const product = new Product({
      name:        req.body.name,
      description: req.body.description,
      price:       parseFloat(req.body.price),
      category:    req.body.category,
      subCategory: req.body.subCategory || '',
      stock:       parseInt(req.body.stock) || 0,
      stockStatus: req.body.stockStatus || 'in_stock',
      images,
      store:  ctx.store._id,
      seller: ctx.user._id,
    });

    await product.save();
    await product.populate('store', 'name');
    res.status(201).json(product);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /products/:id  – seller updates their product ─────────────────────
router.patch('/:id', ClerkExpressRequireAuth({}), upload.array('images', 8), async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ error: 'Product not found' });

    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user || product.seller.toString() !== user._id.toString()) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const fields = ['name', 'description', 'price', 'category', 'subCategory', 'stock', 'stockStatus', 'isActive'];
    fields.forEach(f => { if (req.body[f] !== undefined) product[f] = req.body[f]; });

    if (req.files?.length) {
      product.images = [...product.images, ...req.files.map(f => f.path)];
    }

    await product.save();
    res.json(product);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /products/:id  – seller deletes their product ────────────────────
router.delete('/:id', ClerkExpressRequireAuth({}), async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const product = await Product.findOneAndDelete({ _id: req.params.id, seller: user._id });
    if (!product) return res.status(404).json({ error: 'Product not found or not authorized' });

    res.json({ message: 'Product deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /products/my/inventory  – seller's own products ─────────────────────
router.get('/my/inventory', ClerkExpressRequireAuth({}), async (req, res) => {
  try {
    const user = await User.findOne({ clerkId: req.auth.userId });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const products = await Product.find({ seller: user._id })
      .populate('store', 'name status')
      .sort({ createdAt: -1 });

    res.json(products);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
