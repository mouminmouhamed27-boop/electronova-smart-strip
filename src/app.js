const path = require('path');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const swaggerUi = require('swagger-ui-express');
const swaggerDocument = require('./docs/swagger.json');
const apiRoutes = require('./routes');
const errorHandler = require('./middlewares/errorHandler');
const mqttService = require('./services/mqttService');

const app = express();

// Trust reverse proxy headers (required for Render.com / Railway + express-rate-limit)
app.set('trust proxy', 1);

// Security & Middlewares
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));

// Lightweight healthcheck for Railway / Render / uptime monitors
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'ElectroNova Full-Stack',
    mqttConnected: mqttService.isConnected,
    deviceId: mqttService.deviceId,
    uptimeSec: Math.round(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

// Serve Static Frontend Assets
app.use(express.static(path.join(__dirname, '../public')));

// Interactive Swagger / OpenAPI 3.0 Documentation UI
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument, {
  customSiteTitle: 'ElectroNova API Documentation | Al-Azhar Engineering'
}));

// Rate limiter for API safety
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 mins
  max: 1000,
  message: { success: false, message: 'Too many requests, please try again later.' }
});
app.use('/api', limiter);

// API Endpoints
app.use('/api', apiRoutes);

// JSON 404 handler for unknown /api routes (instead of HTML fallback)
app.use('/api', (req, res) => {
  res.status(404).json({
    success: false,
    message: `API endpoint not found: ${req.method} ${req.originalUrl}`
  });
});

// Fallback to frontend index.html for client routes
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/api-docs')) {
    return next();
  }
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Error handling middleware
app.use(errorHandler);

module.exports = app;
