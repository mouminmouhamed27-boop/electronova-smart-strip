/**
 * Hash Router for 4 Screens (#home, #outlets, #energy, #settings)
 */

import { store } from '../core/store.js';

const VALID_ROUTES = ['home', 'outlets', 'energy', 'settings'];

function parseHash() {
  const raw = (window.location.hash || '#home').replace('#', '').trim().toLowerCase();
  return VALID_ROUTES.includes(raw) ? raw : 'home';
}

export function initRouter(onRouteChange) {
  const applyRoute = () => {
    const route = parseHash();
    store.patch({ route });

    VALID_ROUTES.forEach((r) => {
      const section = document.getElementById(`screen-${r}`);
      if (section) section.classList.toggle('active', r === route);
    });

    document.querySelectorAll('.nav-item[data-route]').forEach((link) => {
      link.classList.toggle('active', link.getAttribute('data-route') === route);
    });

    onRouteChange?.(route);
  };

  window.addEventListener('hashchange', applyRoute);
  applyRoute();
}
