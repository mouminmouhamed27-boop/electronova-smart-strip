/**
 * Lightweight Hand-Written SVG Area Chart (no Chart.js dependency, last 30 points)
 * First point renders at left edge, newest at right.
 */

const NS = 'http://www.w3.org/2000/svg';

function createSvgEl(tag, attrs = {}) {
  const el = document.createElementNS(NS, tag);
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, String(v)));
  return el;
}

export function renderPowerChart(history = []) {
  const svg = document.getElementById('powerChartSvg');
  const empty = document.getElementById('powerChartEmpty');
  if (!svg || !empty) return;

  svg.innerHTML = '';

  if (!Array.isArray(history) || history.length === 0) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  const W = 600;
  const H = 200;
  const padL = 44;
  const padR = 14;
  const padT = 16;
  const padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const maxWatts = Math.max(100, ...history.map((p) => p.watts || 0));
  const yCeiling = Math.ceil(maxWatts / 100) * 100;

  // Defs for gradient fill
  const defs = createSvgEl('defs');
  const grad = createSvgEl('linearGradient', { id: 'enAreaGrad', x1: '0', y1: '0', x2: '0', y2: '1' });
  grad.appendChild(createSvgEl('stop', { offset: '0%', 'stop-color': '#22d3ee', 'stop-opacity': '0.35' }));
  grad.appendChild(createSvgEl('stop', { offset: '100%', 'stop-color': '#22d3ee', 'stop-opacity': '0.02' }));
  defs.appendChild(grad);
  svg.appendChild(defs);

  // Horizontal grid lines & Y labels
  [0, 0.5, 1].forEach((ratio) => {
    const y = padT + plotH * (1 - ratio);
    svg.appendChild(createSvgEl('line', {
      x1: padL, y1: y, x2: W - padR, y2: y,
      stroke: 'rgba(159, 176, 200, 0.16)', 'stroke-width': 1
    }));
    const lbl = createSvgEl('text', {
      x: padL - 6, y: y + 4,
      fill: '#9fb0c8', 'font-size': 10, 'text-anchor': 'end', 'font-family': 'Space Grotesk, sans-serif'
    });
    lbl.textContent = `${Math.round(yCeiling * ratio)}W`;
    svg.appendChild(lbl);
  });

  // Compute coordinates (first point on LEFT)
  const count = history.length;
  const coords = history.map((pt, idx) => {
    const x = count === 1 ? padL : padL + (idx / (count - 1)) * plotW;
    const y = padT + plotH - ((pt.watts || 0) / yCeiling) * plotH;
    return { x, y, label: pt.label, watts: pt.watts || 0 };
  });

  if (coords.length === 1) {
    coords.push({ x: W - padR, y: coords[0].y, label: coords[0].label, watts: coords[0].watts });
  }

  const lineD = coords.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const areaD = `${lineD} L ${coords[coords.length - 1].x.toFixed(1)} ${padT + plotH} L ${coords[0].x.toFixed(1)} ${padT + plotH} Z`;

  svg.appendChild(createSvgEl('path', { d: areaD, fill: 'url(#enAreaGrad)' }));
  svg.appendChild(createSvgEl('path', {
    d: lineD,
    fill: 'none',
    stroke: '#22d3ee',
    'stroke-width': 2.5,
    'stroke-linejoin': 'round',
    'stroke-linecap': 'round'
  }));

  // Highlight latest point
  const last = coords[coords.length - 1];
  svg.appendChild(createSvgEl('circle', {
    cx: last.x, cy: last.y, r: 4.5,
    fill: '#34d399', stroke: '#060b16', 'stroke-width': 2
  }));

  // Time labels (start & end)
  const firstTxt = createSvgEl('text', {
    x: padL, y: H - 6, fill: '#9fb0c8', 'font-size': 10, 'font-family': 'Space Grotesk, sans-serif'
  });
  firstTxt.textContent = history[0].label || '';
  svg.appendChild(firstTxt);

  const lastTxt = createSvgEl('text', {
    x: W - padR, y: H - 6, fill: '#9fb0c8', 'font-size': 10, 'text-anchor': 'end', 'font-family': 'Space Grotesk, sans-serif'
  });
  lastTxt.textContent = history[history.length - 1].label || '';
  svg.appendChild(lastTxt);
}
