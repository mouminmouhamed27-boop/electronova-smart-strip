const express = require('express');
const router = express.Router();
const outletController = require('../controllers/outletController');
const authMiddleware = require('../middlewares/auth.middleware');

// Protect all outlet control routes with JWT auth
router.get('/', authMiddleware, outletController.getOutlets);
router.post('/all', authMiddleware, outletController.setMasterAll);
router.patch('/:id', authMiddleware, outletController.updateOutletMeta);
router.post('/:id', authMiddleware, outletController.setOutlet);
router.post('/:id/timer', authMiddleware, outletController.setTimer);

module.exports = router;
