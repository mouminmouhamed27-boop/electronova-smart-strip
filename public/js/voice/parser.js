/**
 * Pure Dual-Language Voice Command Parser (Arabic & English)
 * Zero DOM dependencies — directly testable in Node via `node --test`.
 */

const EASTERN_DIGITS = '٠١٢٣٤٥٦٧٨٩';

const VERB_ON = new Set([
  'on', 'open', 'start', 'enable',
  'شغل', 'تشغيل', 'افتح', 'فتح', 'ولع', 'نور', 'وصل', 'فعل'
]);

const VERB_OFF = new Set([
  'off', 'close', 'stop', 'shutdown', 'disable',
  'فصل', 'افصل', 'اطفي', 'طفي', 'اطفاء', 'اقفل', 'قفل', 'بند', 'وقف', 'اوقف', 'اغلق', 'سكر', 'ايقاف'
]);

const FUZZY_VERB_ON = new Set(['own', 'up']);
const FUZZY_VERB_OFF = new Set(['of', 'down']);

const NUMBER_WORDS = new Map([
  ['1', 1], ['one', 1], ['first', 1],
  ['واحد', 1], ['واحده', 1], ['الاول', 1], ['الاولي', 1], ['اول', 1], ['اولي', 1],
  ['2', 2], ['two', 2], ['second', 2],
  ['اثنين', 2], ['اتنين', 2], ['الثاني', 2], ['الثانيه', 2], ['التاني', 2], ['التانيه', 2], ['تانيه', 2], ['ثانيه', 2],
  ['3', 3], ['three', 3], ['third', 3],
  ['ثلاثه', 3], ['تلاته', 3], ['الثالث', 3], ['الثالثه', 3], ['التالت', 3], ['التالته', 3], ['تالته', 3], ['ثالثه', 3],
  ['4', 4], ['four', 4], ['fourth', 4],
  ['اربعه', 4], ['الرابع', 4], ['الرابعه', 4], ['رابعه', 4]
]);

const FUZZY_NUMBER_WORDS = new Map([
  ['won', 1], ['want', 1],
  ['to', 2], ['too', 2],
  ['tree', 3], ['free', 3],
  ['for', 4], ['fore', 4]
]);

const ALIAS_WORDS = new Map([
  ['راوتر', 1], ['الراوتر', 1], ['نت', 1], ['النت', 1], ['انترنت', 1], ['router', 1],
  ['كمبيوتر', 2], ['الكمبيوتر', 2], ['شاشه', 2], ['الشاشه', 2], ['لابتوب', 2], ['laptop', 2], ['computer', 2], ['pc', 2],
  ['لمبه', 3], ['اللمبه', 3], ['النور', 3], ['اضاءه', 3], ['الاضاءه', 3], ['light', 3], ['lamp', 3],
  ['شاحن', 4], ['الشاحن', 4], ['شواحن', 4], ['الشواحن', 4], ['charger', 4]
]);

const ALL_WORDS = new Set([
  'all', 'everything', 'every',
  'الكل', 'كله', 'كلها', 'كل', 'جميع', 'الجميع'
]);

const FUZZY_ALL_WORDS = new Set(['hall', 'whole', 'oil', 'old', 'call', 'wall']);

export function normalizeText(raw) {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    .replace(/[٠-٩]/g, (d) => String(EASTERN_DIGITS.indexOf(d)))
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[إأآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/\bshut\s+down\b/g, 'shutdown')
    .replace(/[^a-z0-9\u0621-\u064A\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function classifySingleToken(tok, allowFuzzy, hasPriorVerb) {
  // Handle "نور": noun (outlet 3) if preceded by another verb, else verb ON
  if (tok === 'نور' && hasPriorVerb) {
    return { kind: 'target', id: 3 };
  }
  if (ALL_WORDS.has(tok) || (allowFuzzy && FUZZY_ALL_WORDS.has(tok))) {
    return { kind: 'all' };
  }
  if (VERB_ON.has(tok) || (allowFuzzy && FUZZY_VERB_ON.has(tok))) {
    return { kind: 'verb', state: true, isShutdown: false };
  }
  if (VERB_OFF.has(tok) || (allowFuzzy && FUZZY_VERB_OFF.has(tok))) {
    return { kind: 'verb', state: false, isShutdown: tok === 'shutdown' };
  }
  if (NUMBER_WORDS.has(tok)) {
    return { kind: 'target', id: NUMBER_WORDS.get(tok) };
  }
  if (ALIAS_WORDS.has(tok)) {
    return { kind: 'target', id: ALIAS_WORDS.get(tok) };
  }
  if (allowFuzzy && FUZZY_NUMBER_WORDS.has(tok)) {
    return { kind: 'target', id: FUZZY_NUMBER_WORDS.get(tok) };
  }
  return null;
}

function classifyToken(tok, allowFuzzy, hasPriorVerb) {
  const direct = classifySingleToken(tok, allowFuzzy, hasPriorVerb);
  if (direct) return direct;

  // Accept optional Arabic conjunction prefix "و" ONLY if raw token wasn't an exact match
  if (tok.startsWith('و') && tok.length > 2) {
    return classifySingleToken(tok.slice(1), allowFuzzy, hasPriorVerb);
  }
  return null;
}

function dedupeActions(actions) {
  const seen = new Map();
  const order = [];
  for (const act of actions) {
    const key = act.type === 'all' ? 'all' : `outlet:${act.id}`;
    if (!seen.has(key)) order.push(key);
    seen.set(key, act);
  }
  return order.map((k) => seen.get(k));
}

/**
 * Parse a spoken command string into actionable outlet/all operations.
 * @param {string} rawText
 * @param {{ allowFuzzy?: boolean }} options
 * @returns {{ actions: Array<{type: 'all'|'outlet', id?: number, state: boolean}>, heard: string }}
 */
export function parseCommand(rawText, { allowFuzzy = false } = {}) {
  const clean = normalizeText(rawText);
  if (!clean) {
    return { actions: [], heard: '' };
  }

  // Multi-word fuzzy phrases (only on final transcripts)
  if (allowFuzzy) {
    if (/\b(olaf|all of|hall of)\b/.test(clean)) {
      return { actions: [{ type: 'all', state: false }], heard: rawText.trim() };
    }
    if (/\b(alone|a loan|all in|hold on)\b/.test(clean)) {
      return { actions: [{ type: 'all', state: true }], heard: rawText.trim() };
    }
  }

  const tokens = clean.split(' ').filter(Boolean);
  let currentVerb = null;
  let lastVerbState = null;
  let sawAll = false;
  let sawStandaloneShutdown = false;
  let startsWithTarget = null;
  const pendingTargets = [];
  const outletActions = [];

  for (const tok of tokens) {
    const cls = classifyToken(tok, allowFuzzy, currentVerb !== null);
    if (!cls) continue;

    if (cls.kind === 'all') {
      sawAll = true;
      continue;
    }

    if (startsWithTarget === null) {
      startsWithTarget = cls.kind === 'target';
    }

    if (cls.kind === 'verb') {
      if (cls.isShutdown) sawStandaloneShutdown = true;
      while (pendingTargets.length > 0) {
        outletActions.push({ type: 'outlet', id: pendingTargets.shift(), state: cls.state });
      }
      currentVerb = cls.state;
      lastVerbState = cls.state;
      continue;
    }

    if (cls.kind === 'target') {
      if (!startsWithTarget && currentVerb !== null) {
        outletActions.push({ type: 'outlet', id: cls.id, state: currentVerb });
      } else {
        pendingTargets.push(cls.id);
      }
    }
  }

  // Strong ALL keyword overrides numbers when a verb is present
  if (sawAll && lastVerbState !== null) {
    return {
      actions: [{ type: 'all', state: lastVerbState }],
      heard: rawText.trim()
    };
  }

  // Standalone "shutdown" with no specific numbers -> all OFF
  if (sawStandaloneShutdown && outletActions.length === 0 && pendingTargets.length === 0) {
    return {
      actions: [{ type: 'all', state: false }],
      heard: rawText.trim()
    };
  }

  const finalActions = dedupeActions(outletActions);
  return {
    actions: finalActions,
    heard: rawText.trim()
  };
}
