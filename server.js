const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const http = require('http');
const { Server } = require('socket.io');

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST', 'PATCH', 'DELETE'] }
});

// Export io so route handlers can emit events
module.exports.io = io;

app.use(cors());
app.use(express.json());

// ─── HTTP Routes ──────────────────────────────────────────────────────────────
app.use('/api', require('./routes/api'));
app.use('/api/products', require('./routes/products'));
app.use('/api/cart', require('./routes/cart'));
app.use('/api/chat', require('./routes/chat'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/services', require('./routes/services'));
app.use('/api', require('./routes/testApproval'));   // AI content-moderation: POST /api/test-approval

// ─── Socket.io – Real-time Chat ───────────────────────────────────────────────
const Message = require('./models/Message');
const User    = require('./models/User');

// Map: mongoUserId → socket.id  (for online presence)
const onlineUsers = new Map();

io.on('connection', (socket) => {
  console.log('[socket] connected:', socket.id);

  // Client sends its MongoDB user ID after connecting
  socket.on('register', (mongoUserId) => {
    if (mongoUserId) {
      onlineUsers.set(mongoUserId, socket.id);
      socket.mongoUserId = mongoUserId;
      // Broadcast updated online list
      io.emit('online_users', Array.from(onlineUsers.keys()));
    }
  });

  // Join a private room (deterministic: sorted IDs joined with '_')
  socket.on('join_room', (roomId) => {
    socket.join(roomId);
  });

  // Send a real-time text message and persist to DB
  socket.on('send_message', async (data) => {
    /*
     * data: { roomId, senderId, receiverId, content, tempId }
     * senderId / receiverId are MongoDB _id strings
     */
    try {
      const message = new Message({
        sender:   data.senderId,
        receiver: data.receiverId,
        content:  data.content || '',
        mediaType: 'none',
      });
      await message.save();
      await message.populate('sender',   'firstName lastName profileImageUrl');
      await message.populate('receiver', 'firstName lastName profileImageUrl');

      const payload = { ...message.toObject(), tempId: data.tempId };

      // Send to everyone in the room (including sender's other tabs)
      io.to(data.roomId).emit('receive_message', payload);

      // If receiver is online but NOT in this room, send a notification event
      const receiverSocket = onlineUsers.get(data.receiverId);
      if (receiverSocket) {
        io.to(receiverSocket).emit('new_message_notification', {
          from: message.sender,
          preview: (data.content || '📎 Media').slice(0, 60),
        });
      }
    } catch (err) {
      socket.emit('message_error', { error: err.message, tempId: data.tempId });
    }
  });

  // Typing indicators
  socket.on('typing', ({ roomId, userId }) => {
    socket.to(roomId).emit('user_typing', { userId });
  });
  socket.on('stop_typing', ({ roomId, userId }) => {
    socket.to(roomId).emit('user_stop_typing', { userId });
  });

  socket.on('disconnect', () => {
    if (socket.mongoUserId) {
      onlineUsers.delete(socket.mongoUserId);
      io.emit('online_users', Array.from(onlineUsers.keys()));
    }
    console.log('[socket] disconnected:', socket.id);
  });
});

// ─── DB + Server start ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;

mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('✅ Connected to MongoDB');
    server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
  })
  .catch((err) => console.error('MongoDB connection error:', err));
