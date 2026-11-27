const config = require('../config');

/**
 * Self Keep-Alive Service
 * Periodically sends an inbound HTTP GET to the public /health endpoint
 * (using RAILWAY_PUBLIC_DOMAIN or KEEPALIVE_URL) so cloud HTTP edge proxies
 * reset inactivity timers while the service is running.
 * Note: External uptime monitoring (e.g. cron-job.org every 5 min) or disabling
 * platform App Sleeping is still recommended to wake a cold container.
 */
class KeepAliveService {
  constructor() {
    this.timer = null;
    this.targetUrl = config.keepAlive?.url || '';
    this.intervalMs = config.keepAlive?.intervalMs || 300000;
    this.enabled = Boolean(config.keepAlive?.enabled && this.targetUrl);
    this.pingCount = 0;
    this.lastPingAt = null;
    this.lastPingOk = null;
    this.lastPingStatus = null;
    this.lastPingError = null;
  }

  async pingOnce(overrideUrl = null) {
    const url = overrideUrl || this.targetUrl;
    if (!url) return false;

    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'User-Agent': 'ElectroNova-KeepAlive/1.0' },
        signal: AbortSignal.timeout(8000)
      });
      this.pingCount += 1;
      this.lastPingAt = new Date().toISOString();
      this.lastPingStatus = res.status;
      this.lastPingOk = res.ok;
      this.lastPingError = res.ok ? null : `HTTP ${res.status}`;
      return res.ok;
    } catch (err) {
      this.pingCount += 1;
      this.lastPingAt = new Date().toISOString();
      this.lastPingStatus = null;
      this.lastPingOk = false;
      this.lastPingError = err.message;
      console.warn(`⚠️ [KeepAlive] Self-ping failed (${url}):`, err.message);
      return false;
    }
  }

  start() {
    if (this.timer) return;
    if (!this.enabled) {
      console.log('ℹ️ [KeepAlive] Self-ping skipped (set KEEPALIVE_URL or RAILWAY_PUBLIC_DOMAIN to enable).');
      return;
    }

    const sec = Math.round(this.intervalMs / 1000);
    console.log(`💓 [KeepAlive] Active: pinging ${this.targetUrl} every ${sec}s.`);
    this.timer = setInterval(() => {
      this.pingOnce();
    }, this.intervalMs);
    if (typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('⏹️ [KeepAlive] Stopped.');
    }
  }

  getStatus() {
    return {
      enabled: this.enabled,
      targetUrl: this.targetUrl || null,
      intervalSec: Math.round(this.intervalMs / 1000),
      pingCount: this.pingCount,
      lastPingAt: this.lastPingAt,
      lastPingOk: this.lastPingOk,
      lastPingStatus: this.lastPingStatus,
      lastPingError: this.lastPingError
    };
  }
}

module.exports = new KeepAliveService();
