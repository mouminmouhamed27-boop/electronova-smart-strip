/**
 * Screen 3: Energy & Billing Breakdown View (XSS-safe DOM creation)
 */

export function renderEnergyView(state) {
  const kwhEl = document.getElementById('enTotalKwh');
  const costEl = document.getElementById('enTotalCost');
  const tariffEl = document.getElementById('enTariff');
  const topEl = document.getElementById('enTopOutlet');
  const peakEl = document.getElementById('enPeakWatts');
  const avgEl = document.getElementById('enAvgWatts');
  const projCostEl = document.getElementById('enProjCost');
  const projKwhEl = document.getElementById('enProjKwh');
  const listEl = document.getElementById('energyBreakdown');
  if (!kwhEl || !listEl) return;

  const tariff = state.tariffEgp || 1.25;
  const totalKwh = Number(state.safety.totalKwh || 0);
  const totalCost = Number(state.safety.costEgp || totalKwh * tariff);

  kwhEl.textContent = totalKwh.toFixed(3);
  costEl.textContent = totalCost.toFixed(2);
  tariffEl.textContent = `${tariff.toFixed(2)} EGP/kWh`;

  // Highest consuming outlet right now
  const sortedNow = [...state.outlets].sort((a, b) => (b.currentWatts || 0) - (a.currentWatts || 0));
  const highestNow = sortedNow[0];
  topEl.textContent = highestNow && highestNow.currentWatts > 0
    ? `مخرج ${highestNow.id} (${highestNow.currentWatts}W)`
    : 'لا يوجد حمل نشط';

  // Metrics from backend analytics or computed live from history
  const metrics = state.analytics?.metrics;
  let peakWatts = metrics?.peakWattsRecorded;
  let avgWatts = metrics?.averageWatts;
  let projKwh = metrics?.projectedMonthlyKwh;
  let projCost = metrics?.projectedMonthlyCostEgp;

  if (peakWatts === undefined) {
    const pts = state.history.map((h) => h.watts || 0);
    peakWatts = pts.length > 0 ? Math.max(...pts) : state.safety.totalWatts;
    avgWatts = pts.length > 0 ? Math.round(pts.reduce((s, v) => s + v, 0) / pts.length) : state.safety.totalWatts;
    projKwh = Number(((avgWatts * 24 * 30) / 1000).toFixed(2));
    projCost = Number((projKwh * tariff).toFixed(2));
  }

  peakEl.textContent = Math.round(peakWatts || 0);
  avgEl.textContent = `${Math.round(avgWatts || 0)} W`;
  projKwhEl.textContent = `${Number(projKwh || 0).toFixed(1)} kWh`;
  projCostEl.textContent = Number(projCost || 0).toFixed(2);

  // Per-outlet breakdown bars
  const outletRows = state.analytics?.outlets || state.outlets;
  const sumOutletKwh = outletRows.reduce((acc, o) => acc + Number(o.totalKwh || 0), 0);
  const sumOutletWatts = outletRows.reduce((acc, o) => acc + Number(o.currentWatts || 0), 0);

  listEl.innerHTML = '';
  outletRows.forEach((o) => {
    const kwh = Number(o.totalKwh || 0);
    const watts = Math.round(o.currentWatts || 0);
    let pct = 0;
    if (typeof o.sharePercentage === 'number' && sumOutletKwh > 0) {
      pct = o.sharePercentage;
    } else if (sumOutletKwh > 0) {
      pct = Number(((kwh / sumOutletKwh) * 100).toFixed(1));
    } else if (sumOutletWatts > 0) {
      pct = Number(((watts / sumOutletWatts) * 100).toFixed(1));
    }

    const row = document.createElement('div');
    row.className = 'energy-row';

    const head = document.createElement('div');
    head.className = 'energy-row-head';

    const left = document.createElement('span');
    left.textContent = `مخرج ${o.id} — ${o.name || ''}`;

    const right = document.createElement('span');
    right.className = 'num';
    right.style.color = 'var(--accent)';
    right.textContent = `${kwh.toFixed(3)} kWh (${pct.toFixed(1)}%) • ${watts}W`;

    head.appendChild(left);
    head.appendChild(right);

    const track = document.createElement('div');
    track.className = 'bar-track';
    const fill = document.createElement('div');
    fill.className = 'bar-fill bar-fill-lg';
    fill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
    fill.style.background = o.id === 1 ? 'var(--accent-2)' : o.id === 2 ? 'var(--accent)' : o.id === 3 ? 'var(--warn)' : 'var(--danger)';
    track.appendChild(fill);

    row.appendChild(head);
    row.appendChild(track);
    listEl.appendChild(row);
  });
}
