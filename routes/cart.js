const express = require('express');
const router = express.Router();
const { ClerkExpressRequireAuth } = require('@clerk/clerk-sdk-node');
const Cart = require('../models/Cart');
const Product = require('../models/Product');
const User = require('../models/User');

// ─── Helper: resolve MongoDB user from Clerk ID ───────────────────────────────
async function getUser(clerkId, res) {
  const user = await User.findOne({ clerkId });
  if (!user) { res.status(404).json({ error: 'User not found. Sync your profile first.' }); return null; }
  return user;
}

// ─── GET /cart  – fetch user's cart ──────────────────────────────────────────
router.get('/', ClerkExpressRequireAuth({}), async (req, res) => {
  try {
    const user = await getUser(req.auth.userId, res);
    if (!user) return;

    let cart = await Cart.findOne({ user: user._id })
      .populate({
        path: 'items.product',
        populate: { path: 'store', select: 'name contactOptions' }
      });

    if (!cart) cart = { items: [] };
    res.json(cart);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /cart/add  – add item or increment quantity ────────────────────────
router.post('/add', ClerkExpressRequireAuth({}), async (req, res) => {
  try {
    const user = await getUser(req.auth.userId, res);
    if (!user) return;

    const { productId, quantity = 1 } = req.body;
    const product = await Product.findById(productId);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    if (product.stockStatus === 'out_of_stock') {
      return res.status(400).json({ error: 'Product is out of stock' });
    }

    let cart = await Cart.findOne({ user: user._id });
    if (!cart) {
      cart = new Cart({ user: user._id, items: [] });
    }

    const existingIdx = cart.items.findIndex(i => i.product.toString() === productId);
    if (existingIdx > -1) {
      cart.items[existingIdx].quantity += parseInt(quantity);
    } else {
      cart.items.push({ product: productId, quantity: parseInt(quantity) });
    }

    await cart.save();
    await cart.populate({ path: 'items.product', populate: { path: 'store', select: 'name contactOptions' } });
    res.json(cart);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /cart/update  – set specific quantity ──────────────────────────────
router.patch('/update', ClerkExpressRequireAuth({}), async (req, res) => {
  try {
    const user = await getUser(req.auth.userId, res);
    if (!user) return;

    const { productId, quantity } = req.body;
    const qty = parseInt(quantity);

    let cart = await Cart.findOne({ user: user._id });
    if (!cart) return res.status(404).json({ error: 'Cart not found' });

    if (qty <= 0) {
      // Remove item if quantity set to 0 or less
      cart.items = cart.items.filter(i => i.product.toString() !== productId);
    } else {
      const idx = cart.items.findIndex(i => i.product.toString() === productId);
      if (idx === -1) return res.status(404).json({ error: 'Item not in cart' });
      cart.items[idx].quantity = qty;
    }

    await cart.save();
    await cart.populate({ path: 'items.product', populate: { path: 'store', select: 'name contactOptions' } });
    res.json(cart);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /cart/remove/:productId  – remove a single item ──────────────────
router.delete('/remove/:productId', ClerkExpressRequireAuth({}), async (req, res) => {
  try {
    const user = await getUser(req.auth.userId, res);
    if (!user) return;

    const cart = await Cart.findOne({ user: user._id });
    if (!cart) return res.status(404).json({ error: 'Cart not found' });

    cart.items = cart.items.filter(i => i.product.toString() !== req.params.productId);
    await cart.save();
    await cart.populate({ path: 'items.product', populate: { path: 'store', select: 'name contactOptions' } });
    res.json(cart);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /cart/clear  – empty the cart ────────────────────────────────────
router.delete('/clear', ClerkExpressRequireAuth({}), async (req, res) => {
  try {
    const user = await getUser(req.auth.userId, res);
    if (!user) return;

    await Cart.findOneAndUpdate({ user: user._id }, { items: [] });
    res.json({ message: 'Cart cleared' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
