const express = require('express');
const router = express.Router();
const analyticsController = require('../controllers/analyticsController');
const authMiddleware = require('../middlewares/auth.middleware');

router.get('/energy', authMiddleware, analyticsController.getEnergySummary);

module.exports = router;
