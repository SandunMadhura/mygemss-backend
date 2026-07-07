const mongoose = require('mongoose');

const AdSchema = new mongoose.Schema({
  imageUrl:  { type: String, required: true },
  title:     { type: String, default: '' },
  link:      { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Ad', AdSchema);
