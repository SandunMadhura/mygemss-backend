const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  clerkId: { type: String, required: true, unique: true },
  email:   { type: String, required: true, unique: true },
  firstName: String,
  lastName:  String,
  profileImageUrl: String,
  bio: { type: String, default: '' },
  role: {
    type: String,
    enum: ['normal', 'seller', 'admin'],
    default: 'normal'
  },
  isBlocked:    { type: Boolean, default: false },
  warningCount: { type: Number,  default: 0    },
  createdAt:    { type: Date,    default: Date.now }
});

module.exports = mongoose.model('User', UserSchema);

