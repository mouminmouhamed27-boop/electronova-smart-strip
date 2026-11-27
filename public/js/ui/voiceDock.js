/**
 * Floating Persistent Voice Dock (all 4 screens)
 */

import { store } from '../core/store.js';
import { STRINGS } from '../strings.js';
import { createVoiceEngine, isSpeechSupported } from '../voice/engine.js';
import { createVoiceRouter } from '../voice/router.js';

export function initVoiceDock(controller) {
  const btnMic = document.getElementById('btnVoiceDock');
  const btnLang = document.getElementById('btnVoiceLangDock');

  const cfg = controller.getConfig();
  const supported = isSpeechSupported();

  store.setState((prev) => ({
    ...prev,
    voice: {
      ...prev.voice,
      supported,
      lang: cfg.voiceLang || 'ar-EG',
      mode: cfg.voiceMode || 'instant',
      beeps: cfg.voiceBeeps !== false,
      pillText: supported ? prev.voice.pillText : STRINGS.browserUnsupported,
      pillMode: supported ? 'idle' : 'bad'
    }
  }));

  if (!supported) {
    if (btnMic) btnMic.disabled = true;
    return;
  }

  const routeSpeech = createVoiceRouter({
    getMode: () => store.getState().voice.mode,
    onTranscript(transcript) {
      store.setState((prev) => ({
        ...prev,
        voice: {
          ...prev.voice,
          pillText: `🗣️ "${transcript}"`,
          pillMode: 'hearing'
        }
      }));
    },
    onExecute(actions, heard) {
      controller.executeVoiceActions(actions, heard);
    }
  });

  const engine = createVoiceEngine({
    lang: cfg.voiceLang || 'ar-EG',
    onState(active) {
      store.setState((prev) => ({
        ...prev,
        voice: {
          ...prev.voice,
          active,
          pillText: active
            ? (prev.voice.lang.startsWith('ar')
                ? '🎙️ استماع مستمر (عربي)... قل: "شغل الراوتر" أو "شغل واحد وتلاتة"'
                : '🎙️ Listening (EN)... say: "turn on 1" or "all off"')
            : prev.voice.pillText,
          pillMode: active ? 'hearing' : prev.voice.pillMode === 'hearing' ? 'idle' : prev.voice.pillMode
        }
      }));
    },
    onResult: routeSpeech,
    onError(err) {
      if (err === 'denied') {
        store.setState((prev) => ({
          ...prev,
          voice: {
            ...prev.voice,
            active: false,
            pillText: '❌ تم رفض صلاحية المايك من المتصفح',
            pillMode: 'bad'
          }
        }));
      }
    }
  });

  btnMic?.addEventListener('click', () => {
    const st = store.getState();
    if (st.voice.active) {
      engine.stop();
      store.setState((prev) => ({
        ...prev,
        voice: { ...prev.voice, active: false, pillText: 'تم إيقاف المايك', pillMode: 'idle' }
      }));
    } else {
      engine.start();
    }
  });

  btnLang?.addEventListener('click', () => {
    const currLang = store.getState().voice.lang;
    const nextLang = currLang.startsWith('ar') ? 'en-US' : 'ar-EG';
    engine.setLang(nextLang);
    controller.setVoiceConfig({ voiceLang: nextLang });
    const sel = document.getElementById('cfgVoiceLang');
    if (sel) sel.value = nextLang;
  });

  // Sync voice engine language when changed from Settings page
  document.getElementById('cfgVoiceLang')?.addEventListener('change', (e) => {
    const nextLang = e.target.value;
    engine.setLang(nextLang);
    controller.setVoiceConfig({ voiceLang: nextLang });
  });
}
