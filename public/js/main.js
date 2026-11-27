/**
 * ElectroNova Smart Power Strip — Frontend Bootstrap (ES Module Entry)
 */

import { createTransport } from './transport/index.js';
import { createController } from './core/controller.js';
import { showToast } from './ui/toast.js';
import { initRouter } from './ui/router.js';
import { initOutletCards } from './ui/outletCards.js';
import { initVoiceDock } from './ui/voiceDock.js';
import { initSettingsAndModals } from './ui/settings.js';
import { initRenderer, triggerShake } from './ui/render.js';

let authOpener = null;

const controller = createController({
  createTransport,
  onToast: showToast,
  onShake: triggerShake,
  onAuthRequired: (msg) => authOpener?.(msg)
});

window.addEventListener('DOMContentLoaded', () => {
  initOutletCards(controller);
  const modals = initSettingsAndModals(controller, { showToast });
  authOpener = modals.openAuthModal;

  initVoiceDock(controller);
  initRenderer(controller);
  initRouter((route) => {
    if (route === 'energy') {
      controller.refreshAnalytics();
    }
  });

  controller.start();
});
