const express = require('express');
const router = express.Router();
const safetyController = require('../controllers/safetyController');
const authMiddleware = require('../middlewares/auth.middleware');

router.get('/status', safetyController.getSafetyStatus);
router.post('/unlock', authMiddleware, safetyController.unlockSafety);
router.post('/sequential-restore', authMiddleware, safetyController.sequentialRestore);

module.exports = router;
