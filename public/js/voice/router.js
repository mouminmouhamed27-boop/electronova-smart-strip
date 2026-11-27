/**
 * Voice Result Deduplication & Execution Router
 * Supports instant interim strict matching + fuzzy matching on final transcripts.
 */

import { parseCommand } from './parser.js';

export function createVoiceRouter({ getMode, onTranscript, onExecute }) {
  const executedByResult = new Map(); // resultIndex -> Set<signature>
  const lastExecutedAt = new Map();   // signature -> timestampMs

  function pruneMaps() {
    if (executedByResult.size > 50) {
      const keys = Array.from(executedByResult.keys());
      for (let i = 0; i < keys.length - 30; i++) {
        executedByResult.delete(keys[i]);
      }
    }
    if (lastExecutedAt.size > 50) {
      const now = Date.now();
      for (const [sig, ts] of lastExecutedAt.entries()) {
        if (now - ts > 5000) lastExecutedAt.delete(sig);
      }
    }
  }

  function formatSig(act) {
    return `${act.type}:${act.id ?? 'all'}:${act.state ? 'on' : 'off'}`;
  }

  function extractActions(result, allowFuzzy) {
    const alts = Array.from(result).map((alt) => alt.transcript || '');
    // Strict pass across all alternatives first
    for (const txt of alts) {
      const parsed = parseCommand(txt, { allowFuzzy: false });
      if (parsed.actions.length > 0) return parsed;
    }
    // Fuzzy pass on final results only
    if (allowFuzzy) {
      for (const txt of alts) {
        const parsed = parseCommand(txt, { allowFuzzy: true });
        if (parsed.actions.length > 0) return parsed;
      }
    }
    return { actions: [], heard: (alts[0] || '').trim() };
  }

  return function handleSpeechEvent(event) {
    const mode = getMode ? getMode() : 'instant';

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const topTranscript = (result[0]?.transcript || '').trim();
      if (!topTranscript) continue;

      onTranscript?.(topTranscript, result.isFinal);

      if (mode === 'final' && !result.isFinal) {
        continue;
      }

      const allowFuzzy = Boolean(result.isFinal);
      const parsed = extractActions(result, allowFuzzy);
      if (parsed.actions.length === 0) continue;

      if (!executedByResult.has(i)) {
        executedByResult.set(i, new Set());
      }
      const resultSet = executedByResult.get(i);
      const now = Date.now();

      const freshActions = [];
      for (const act of parsed.actions) {
        const sig = formatSig(act);
        if (resultSet.has(sig)) continue;
        const prevTs = lastExecutedAt.get(sig) || 0;
        if (now - prevTs < 500) continue;

        resultSet.add(sig);
        lastExecutedAt.set(sig, now);
        freshActions.push(act);
      }

      if (freshActions.length > 0) {
        pruneMaps();
        onExecute?.(freshActions, parsed.heard || topTranscript);
      }
    }
  };
}
