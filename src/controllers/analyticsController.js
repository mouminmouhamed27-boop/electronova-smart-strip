const analyticsService = require('../services/analyticsService');

exports.getEnergySummary = (req, res, next) => {
  try {
    const summary = analyticsService.getSummary();
    return res.json({
      success: true,
      data: summary
    });
  } catch (err) {
    next(err);
  }
};
