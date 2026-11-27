const express = require('express');
const router = express.Router();
const telemetryController = require('../controllers/telemetryController');
const authMiddleware = require('../middlewares/auth.middleware');

router.get('/live', telemetryController.getLive);
router.get('/history', telemetryController.getHistory);
router.get('/assistants', telemetryController.getAssistantsStatus);
router.get('/firmware', telemetryController.getFirmwareInfo);
router.get('/logs', authMiddleware, telemetryController.getLogs);
router.post('/energy/reset', authMiddleware, telemetryController.resetEnergy);
router.post('/sync', authMiddleware, telemetryController.requestSync);
router.post('/device', authMiddleware, telemetryController.switchDevice);
router.post('/ota', authMiddleware, telemetryController.triggerOtaUpdate);

module.exports = router;
