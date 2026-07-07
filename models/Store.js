const mongoose = require('mongoose');

const StoreSchema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name:  { type: String, required: true },
  description: String,
  location:    String,
  identityProofUrl: String,
  category: {
    type: String,
    enum: ['Gemstones', 'Gem Tools', 'Jewelry Shops', 'Gem Services'],
    required: true
  },
  logoUrl:        String,
  bannerUrl:      String,
  coverImageUrl:  String,
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'suspended'],
    default: 'pending'
  },
  contactOptions: {
    chatEnabled: { type: Boolean, default: true },
    phone: String
  },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Store', StoreSchema);

