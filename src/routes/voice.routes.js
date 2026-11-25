const express = require('express');
const router = express.Router();
const voiceController = require('../controllers/voiceController');
const authMiddleware = require('../middlewares/auth.middleware');

// Voice command API (Accepts transcript in Arabic or English)
router.post('/command', authMiddleware, voiceController.processVoiceCommand);

module.exports = router;
