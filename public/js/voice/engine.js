/**
 * Continuous SpeechRecognition Wrapper (zero-lag auto-restart, Chrome/Edge)
 */

export function isSpeechSupported() {
  return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
}

export function createVoiceEngine({ lang = 'ar-EG', onState, onResult, onError } = {}) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    return {
      supported: false,
      start() {},
      stop() {},
      setLang() {}
    };
  }

  const recognition = new SR();
  recognition.lang = lang;
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 5;

  let shouldRun = false;
  let restartTimer = null;

  recognition.onstart = () => {
    onState?.(true);
  };

  recognition.onresult = (event) => {
    onResult?.(event);
  };

  recognition.onerror = (event) => {
    const err = event.error;
    if (err === 'not-allowed' || err === 'service-not-allowed') {
      shouldRun = false;
      clearTimeout(restartTimer);
      onState?.(false);
      onError?.('denied');
      return;
    }
    // Recover silently on transient Chrome speech errors
    if (err === 'no-speech' || err === 'network' || err === 'aborted') {
      return;
    }
    onError?.(err);
  };

  recognition.onend = () => {
    if (shouldRun) {
      clearTimeout(restartTimer);
      restartTimer = setTimeout(() => {
        if (shouldRun) {
          try {
            recognition.start();
          } catch (_) {}
        }
      }, 120);
    } else {
      onState?.(false);
    }
  };

  return {
    supported: true,
    start() {
      shouldRun = true;
      clearTimeout(restartTimer);
      try {
        recognition.start();
      } catch (_) {}
    },
    stop() {
      shouldRun = false;
      clearTimeout(restartTimer);
      try {
        recognition.stop();
      } catch (_) {}
      onState?.(false);
    },
    setLang(nextLang) {
      recognition.lang = nextLang;
      if (shouldRun) {
        clearTimeout(restartTimer);
        try {
          recognition.stop();
        } catch (_) {}
      }
    }
  };
}
