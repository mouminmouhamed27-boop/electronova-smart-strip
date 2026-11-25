const express = require('express');
const router = express.Router();

const authRoutes = require('./auth.routes');
const outletRoutes = require('./outlet.routes');
const telemetryRoutes = require('./telemetry.routes');
const scheduleRoutes = require('./schedule.routes');
const voiceRoutes = require('./voice.routes');
const safetyRoutes = require('./safety.routes');
const analyticsRoutes = require('./analytics.routes');

router.use('/auth', authRoutes);
router.use('/outlets', outletRoutes);
router.use('/telemetry', telemetryRoutes);
router.use('/schedules', scheduleRoutes);
router.use('/voice', voiceRoutes);
router.use('/safety', safetyRoutes);
router.use('/analytics', analyticsRoutes);

// Health check & API Overview
router.get('/', (req, res) => {
  res.json({
    status: 'online',
    system: 'ElectroNova Smart Power Strip API v1.0',
    documentation: '/api-docs',
    university: 'Al-Azhar University, Faculty of Engineering',
    modules: {
      auth: ['POST /api/auth/login', 'POST /api/auth/register', 'GET /api/auth/me'],
      outlets: ['GET /api/outlets', 'POST /api/outlets/:id', 'POST /api/outlets/all', 'POST /api/outlets/:id/timer'],
      voice: ['POST /api/voice/command (Supports Arabic & English)'],
      safety: ['GET /api/safety/status', 'POST /api/safety/unlock', 'POST /api/safety/sequential-restore'],
      analytics: ['GET /api/analytics/energy'],
      telemetry: [
        'GET /api/telemetry/live',
        'GET /api/telemetry/history',
        'GET /api/telemetry/logs',
        'POST /api/telemetry/energy/reset',
        'POST /api/telemetry/sync',
        'POST /api/telemetry/device'
      ],
      schedules: ['GET /api/schedules', 'POST /api/schedules/:id']
    }
  });
});

module.exports = router;
