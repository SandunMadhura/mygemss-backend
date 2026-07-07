const express = require('express');
const router = express.Router();
const { ClerkExpressRequireAuth } = require('@clerk/clerk-sdk-node');
const Message = require('../models/Message');
const User = require('../models/User');
const { upload } = require('../config/cloudinary');

// ─── Helper ───────────────────────────────────────────────────────────────────
async function getUser(clerkId, res) {
  const user = await User.findOne({ clerkId });
  if (!user) { res.status(404).json({ error: 'User not found. Sync your profile first.' }); return null; }
  return user;
}

// Deterministic room ID: always same string for any pair of user IDs
function roomId(idA, idB) {
  return [idA, idB].map(String).sort().join('_');
}

// ─── GET /chat/contacts – list of users this person has chatted with ──────────
router.get('/contacts', ClerkExpressRequireAuth({}), async (req, res) => {
  try {
    const me = await getUser(req.auth.userId, res);
    if (!me) return;

    // Find all messages involving me, get unique other-user IDs
    const messages = await Message.find({
      $or: [{ sender: me._id }, { receiver: me._id }]
    }).sort({ createdAt: -1 });

    const seen = new Set();
    const contactIds = [];
    for (const m of messages) {
      const otherId = m.sender.toString() === me._id.toString()
        ? m.receiver.toString()
        : m.sender.toString();
      if (!seen.has(otherId)) { seen.add(otherId); contactIds.push(otherId); }
    }

    const contacts = await User.find({ _id: { $in: contactIds } })
      .select('firstName lastName profileImageUrl role');

    // Attach latest message snippet for each contact
    const contactsWithPreview = await Promise.all(contacts.map(async (c) => {
      const last = await Message.findOne({
        $or: [
          { sender: me._id, receiver: c._id },
          { sender: c._id, receiver: me._id }
        ]
      }).sort({ createdAt: -1 });
      return { ...c.toObject(), lastMessage: last };
    }));

    res.json(contactsWithPreview);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /chat/history/:userId – full message thread with one user ────────────
router.get('/history/:userId', ClerkExpressRequireAuth({}), async (req, res) => {
  try {
    const me = await getUser(req.auth.userId, res);
    if (!me) return;

    const other = await User.findById(req.params.userId).select('firstName lastName profileImageUrl role');
    if (!other) return res.status(404).json({ error: 'User not found' });

    const messages = await Message.find({
      $or: [
        { sender: me._id, receiver: other._id },
        { sender: other._id, receiver: me._id }
      ]
    })
      .populate('sender', 'firstName lastName profileImageUrl')
      .populate('receiver', 'firstName lastName profileImageUrl')
      .sort({ createdAt: 1 });

    // Mark unread as read
    await Message.updateMany(
      { sender: other._id, receiver: me._id, read: false },
      { read: true }
    );

    res.json({ messages, contact: other });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /chat/send – send a message (REST fallback + media upload) ──────────
router.post('/send', ClerkExpressRequireAuth({}), upload.single('media'), async (req, res) => {
  try {
    const me = await getUser(req.auth.userId, res);
    if (!me) return;

    const { receiverId, content } = req.body;
    if (!receiverId) return res.status(400).json({ error: 'receiverId is required' });

    let mediaUrl = null;
    let mediaType = 'none';
    if (req.file) {
      mediaUrl = req.file.path;
      const mime = req.file.mimetype || '';
      if (mime.startsWith('image')) mediaType = 'image';
      else if (mime.startsWith('video')) mediaType = 'video';
      else if (mime.startsWith('audio')) mediaType = 'voice';
    }

    const message = new Message({
      sender: me._id,
      receiver: receiverId,
      content: content || '',
      mediaUrl,
      mediaType,
    });

    await message.save();
    await message.populate('sender', 'firstName lastName profileImageUrl');
    await message.populate('receiver', 'firstName lastName profileImageUrl');

    res.status(201).json(message);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /chat/unread-count – badge count for sidebar ────────────────────────
router.get('/unread-count', ClerkExpressRequireAuth({}), async (req, res) => {
  try {
    const me = await getUser(req.auth.userId, res);
    if (!me) return;
    const count = await Message.countDocuments({ receiver: me._id, read: false });
    res.json({ count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /chat/user/:userId – get a user's public info (for starting new chat) ─
router.get('/user/:userId', ClerkExpressRequireAuth({}), async (req, res) => {
  try {
    const user = await User.findById(req.params.userId).select('firstName lastName profileImageUrl role');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /chat/users – directory of all registered users (excluding caller) ────
router.get('/users', ClerkExpressRequireAuth({}), async (req, res) => {
  try {
    const me = await getUser(req.auth.userId, res);
    if (!me) return;

    // Optional query param for search
    const { q } = req.query;
    let query = { _id: { $ne: me._id } };

    if (q) {
      const regex = new RegExp(q, 'i');
      query.$or = [{ firstName: regex }, { lastName: regex }];
    }

    const users = await User.find(query)
      .select('firstName lastName profileImageUrl role')
      .limit(50); // limit to 50 for performance

    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
