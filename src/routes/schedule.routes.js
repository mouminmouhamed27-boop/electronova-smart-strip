const express = require('express');
const router = express.Router();
const scheduleController = require('../controllers/scheduleController');
const authMiddleware = require('../middlewares/auth.middleware');

router.get('/', authMiddleware, scheduleController.getSchedules);
router.post('/:id', authMiddleware, scheduleController.updateSchedule);

module.exports = router;
