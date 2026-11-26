const storage = require('./storageService');

/**
 * Energy & Billing Analytics Service
 * Computes energy consumption statistics, projections, and tariff costs.
 */
class AnalyticsService {
  getSummary() {
    const dev = storage.getDeviceState();
    const history = storage.data.telemetryHistory;
    const tariff = dev.tariffEgp || 1.25;

    const totalKwh = dev.safety.totalKwh || 0.0;
    const totalCostEgp = (totalKwh * tariff).toFixed(2);

    // Calculate per-outlet energy shares
    const perOutletBreakdown = dev.outlets.map(o => {
      const kwh = o.totalKwh || 0.0;
      const cost = (kwh * tariff).toFixed(2);
      const sharePct = totalKwh > 0 ? ((kwh / totalKwh) * 100).toFixed(1) : '0.0';

      return {
        id: o.id,
        name: o.name,
        currentWatts: o.currentWatts,
        currentAmps: o.currentAmps,
        totalKwh: kwh,
        costEgp: parseFloat(cost),
        sharePercentage: parseFloat(sharePct)
      };
    });

    // Compute peak power recorded
    let peakWatts = 0;
    let avgWatts = 0;
    if (history.length > 0) {
      const wattsList = history.map(h => h.totalWatts || 0);
      peakWatts = Math.max(...wattsList);
      avgWatts = Math.round(wattsList.reduce((acc, v) => acc + v, 0) / wattsList.length);
    } else {
      peakWatts = dev.safety.totalWatts;
      avgWatts = dev.safety.totalWatts;
    }

    // Monthly projection based on average power
    // (avgWatts * 24h * 30 days) / 1000
    const projectedMonthlyKwh = parseFloat(((avgWatts * 24 * 30) / 1000).toFixed(2));
    const projectedMonthlyCost = parseFloat((projectedMonthlyKwh * tariff).toFixed(2));

    return {
      tariffPerKwh: tariff,
      currency: 'EGP',
      currentTotalWatts: dev.safety.totalWatts,
      currentTotalAmps: dev.safety.totalAmps,
      cumulativeKwh: totalKwh,
      totalCostEgp: parseFloat(totalCostEgp),
      metrics: {
        peakWattsRecorded: peakWatts,
        averageWatts: avgWatts,
        projectedMonthlyKwh,
        projectedMonthlyCostEgp: projectedMonthlyCost
      },
      outlets: perOutletBreakdown,
      historyLength: history.length,
      historySummary: history.slice(-20) // Last 20 data points
    };
  }
}

module.exports = new AnalyticsService();
