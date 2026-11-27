/**
 * Floating Smart Assistants & AI Command Dock (Google Home / Alexa Bridge + Backend AI)
 * Replaces browser SpeechRecognition mic with reliable server-synced Assistant integration.
 */

import { store } from '../core/store.js';

export function initVoiceDock(controller) {
  const form = document.getElementById('assistantCommandForm');
  const input = document.getElementById('assistantCommandInput');
  const bridgeBtn = document.getElementById('btnAssistantBridgePill');

  bridgeBtn?.addEventListener('click', () => {
    window.location.hash = '#settings';
  });

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const txt = (input?.value || '').trim();
    if (!txt) return;
    const ok = await controller.executeSmartCommand(txt);
    if (ok && input) {
      input.value = '';
    }
  });

  // Update placeholder / status pill hint gracefully when assistantBar state changes
  store.subscribe((state) => {
    const submitBtn = document.getElementById('btnAssistantSend');
    if (submitBtn) {
      submitBtn.disabled = Boolean(state.assistantBar?.busy);
    }
  });
}
