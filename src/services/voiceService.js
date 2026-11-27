const config = require('../config');
const storage = require('./storageService');

/**
 * Unified Command Parser & AI Intent Resolver (Arabic & English)
 * Supports:
 *  1) Gemini Interactions API (when GEMINI_API_KEY is configured on Railway)
 *     for natural Egyptian Arabic & status questions
 *  2) Built-in zero-latency dual-language NLP fallback
 */
class VoiceService {
  constructor() {
    this.arabicNumbers = {
      'واحد': 1, 'واحده': 1, 'الاول': 1, 'الاولي': 1, 'اول': 1, 'اولي': 1, '1': 1,
      'اثنين': 2, 'اتنين': 2, 'الثاني': 2, 'الثانيه': 2, 'التاني': 2, 'التانيه': 2, 'تانيه': 2, 'ثانيه': 2, '2': 2,
      'ثلاثة': 3, 'ثلاثه': 3, 'تلاتة': 3, 'تلاته': 3, 'الثالث': 3, 'الثالثه': 3, 'التالت': 3, 'التالته': 3, 'تالته': 3, 'ثالثه': 3, '3': 3,
      'اربعة': 4, 'اربعه': 4, 'الرابع': 4, 'الرابعه': 4, 'رابعه': 4, '4': 4
    };

    this.outletAliases = {
      'الراوتر': 1, 'راوتر': 1, 'النت': 1, 'نت': 1, 'انترنت': 1, 'router': 1,
      'الكمبيوتر': 2, 'كمبيوتر': 2, 'بي سي': 2, 'pc': 2, 'computer': 2, 'الشاشه': 2, 'شاشه': 2, 'لابتوب': 2, 'laptop': 2,
      'اللمبه': 3, 'لمبه': 3, 'النور': 3, 'نور': 3, 'الاضاءه': 3, 'اضاءه': 3, 'light': 3, 'lamp': 3,
      'الشواحن': 4, 'شواحن': 4, 'الشاحن': 4, 'شاحن': 4, 'charger': 4
    };
  }

  normalizeArabic(text) {
    const easternToWestern = text.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
    return easternToWestern
      .toLowerCase()
      .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
      .replace(/[إأآا]/g, 'ا')
      .replace(/ة/g, 'ه')
      .replace(/ى/g, 'ي')
      .replace(/[^\w\s\u0621-\u064A0-9]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  parseCommand(rawTranscript) {
    if (!rawTranscript || typeof rawTranscript !== 'string') {
      return { matched: false, actions: [], message: 'Empty or invalid voice transcript.' };
    }

    const raw = rawTranscript.trim();
    const cleanAr = this.normalizeArabic(raw);
    const cleanEn = raw
      .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
      .toLowerCase()
      .replace(/shut\s+down/g, 'shutdown')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // 1. Master Commands
    const isMasterOff =
      /(?:فصل|افصل|اطفي|طفي|اقفل|بند|اغلق|سكر)\s+(?:الكل|كله|كلها|الجميع|(?:كل|جميع)\s+\S+)/.test(cleanAr) ||
      /\b(all off|turn off all|shutdown all|power off all|turn everything off|lights off|all of|olaf|hall of|shutdown)\b/.test(cleanEn);

    if (isMasterOff) {
      return {
        matched: true,
        type: 'all',
        state: false,
        actions: [{ type: 'all', state: false }],
        spoken: raw,
        feedbackAr: 'تم فصل جميع المخارج بنجاح',
        feedbackEn: 'All outlets turned OFF successfully'
      };
    }

    const isMasterOn =
      /(?:شغل|افتح|ولع|نور)\s+(?:الكل|كله|كلها|الجميع|(?:كل|جميع)\s+\S+)/.test(cleanAr) ||
      /\b(all on|turn on all|power on all|turn everything on|lights on)\b/.test(cleanEn);

    if (isMasterOn) {
      return {
        matched: true,
        type: 'all',
        state: true,
        actions: [{ type: 'all', state: true }],
        spoken: raw,
        feedbackAr: 'تم تشغيل جميع المخارج بنجاح',
        feedbackEn: 'All outlets turned ON successfully'
      };
    }

    // 2. Determine Action
    let targetState = null;
    const hasTurnOnAr = /(?:^|\s)و?(?:شغل|تشغيل|افتح|فتح|ولع|نور|وصل|فعل)(?:\s|$)/.test(cleanAr);
    const hasTurnOffAr = /(?:^|\s)و?(?:فصل|افصل|اطفي|طفي|اطفاء|اقفل|قفل|بند|وقف|اوقف|اغلق|سكر)(?:\s|$)/.test(cleanAr);

    const hasTurnOnEn = /\b(on|open|start|enable|up)\b/.test(cleanEn);
    const hasTurnOffEn = /\b(off|close|stop|shutdown|shut|disable|down)\b/.test(cleanEn);

    if (hasTurnOnAr || hasTurnOnEn) targetState = true;
    if (hasTurnOffAr || hasTurnOffEn) targetState = false;

    if (targetState === null) {
      return {
        matched: false,
        actions: [],
        spoken: raw,
        message: 'Could not determine action (ON or OFF).'
      };
    }

    // 3. Collect Outlet IDs (dynamic device outlet names + static aliases + numbers)
    const foundIds = new Set();
    const dev = storage.getDeviceState();
    (dev.outlets || []).forEach((o) => {
      const words = this.normalizeArabic(o.name || '').split(/\s+/).filter((w) => w.length >= 3);
      for (const w of words) {
        if (new RegExp(`(?:^|\\s)${w}(?:\\s|$)`).test(cleanAr)) {
          foundIds.add(o.id);
        }
      }
    });

    for (const [alias, id] of Object.entries(this.outletAliases)) {
      const normAlias = this.normalizeArabic(alias);
      const arWordRx = new RegExp(`(?:^|\\s)${normAlias}(?:\\s|$)`);
      const enWordRx = new RegExp(`\\b${alias.replace(/\s+/g, '\\s+')}\\b`);
      if (arWordRx.test(cleanAr) || enWordRx.test(cleanEn)) {
        foundIds.add(id);
      }
    }

    for (const [word, id] of Object.entries(this.arabicNumbers)) {
      const rx = new RegExp(`(?:^|\\s)و?${word}(?:\\s|$)`);
      if (rx.test(cleanAr)) foundIds.add(id);
    }

    const enMatches = cleanEn.match(/\b(1|one|first|won|2|two|second|3|three|third|tree|4|four|fourth|fore)\b/g);
    if (enMatches) {
      enMatches.forEach((val) => {
        if (['1', 'one', 'first', 'won'].includes(val)) foundIds.add(1);
        else if (['2', 'two', 'second'].includes(val)) foundIds.add(2);
        else if (['3', 'three', 'third', 'tree'].includes(val)) foundIds.add(3);
        else if (['4', 'four', 'fourth', 'fore'].includes(val)) foundIds.add(4);
      });
    }

    if (foundIds.size === 0) {
      if (cleanAr.includes('الكل') || cleanAr.includes('كله') || cleanEn.includes('all')) {
        return {
          matched: true,
          type: 'all',
          state: targetState,
          actions: [{ type: 'all', state: targetState }],
          spoken: raw,
          feedbackAr: `تم ${targetState ? 'تشغيل' : 'فصل'} جميع المخارج`,
          feedbackEn: `All outlets turned ${targetState ? 'ON' : 'OFF'}`
        };
      }

      return {
        matched: false,
        actions: [],
        spoken: raw,
        message: 'Action found, but outlet number (1 to 4) was not detected.'
      };
    }

    const ids = [...foundIds].sort((a, b) => a - b);
    const actions = ids.map((id) => ({ type: 'outlet', id, state: targetState }));

    return {
      matched: true,
      type: 'outlet',
      id: ids[0],
      state: targetState,
      actions,
      spoken: raw,
      feedbackAr: `تم ${targetState ? 'تشغيل' : 'فصل'} ${ids.map((id) => `مخرج ${id}`).join(' و ')} بنجاح`,
      feedbackEn: `Turned ${targetState ? 'ON' : 'OFF'} outlet(s) ${ids.join(', ')}`
    };
  }

  /**
   * Natural-language Egyptian Arabic + English AI command parser (Gemini Interactions API)
   * Automatically falls back to deterministic parser when GEMINI_API_KEY is unset or network fails.
   */
  async parseCommandWithAI(rawTranscript) {
    const fast = this.parseCommand(rawTranscript);
    if (!config.gemini?.apiKey) return fast;

    const dev = storage.getDeviceState();
    const outletList = (dev.outlets || [])
      .map((o) => `Outlet ${o.id}: "${o.name}" (Priority P${o.priority}, ${o.isProtected ? 'Protected' : 'Normal'}, currently ${o.state ? 'ON' : 'OFF'}, ${o.currentAmps}A)`)
      .join('\n');

    const prompt = [
      'You are the ElectroNova Smart Power Strip AI assistant (Egyptian Arabic & English).',
      'Current strip status:',
      `Online: ${dev.isOnline}, Temp: ${dev.safety.temperatureC}C, Total: ${dev.safety.totalAmps}A / 16A, Watts: ${dev.safety.totalWatts}W, Alert: ${dev.safety.alert}.`,
      outletList,
      `User said: "${String(rawTranscript || '').trim()}"`,
      'Decide the exact outlet actions (or empty actions if just asking status). Reply concisely in Egyptian Arabic.'
    ].join('\n');

    try {
      const res = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': config.gemini.apiKey,
          'Api-Revision': '2026-05-20'
        },
        body: JSON.stringify({
          model: config.gemini.model || 'gemini-3.8-flash',
          input: prompt,
          response_format: {
            type: 'text',
            mime_type: 'application/json',
            schema: {
              type: 'object',
              properties: {
                matched: { type: 'boolean' },
                statusOnly: { type: 'boolean' },
                actions: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      type: { type: 'string', enum: ['outlet', 'all'] },
                      id: { type: 'integer' },
                      state: { type: 'boolean' }
                    },
                    required: ['type', 'state']
                  }
                },
                feedbackAr: { type: 'string' },
                feedbackEn: { type: 'string' }
              },
              required: ['matched', 'actions', 'feedbackAr', 'feedbackEn']
            }
          }
        }),
        signal: AbortSignal.timeout(7000)
      });

      if (!res.ok) return fast;
      const body = await res.json();
      const rawJson = body.output_text || body.outputs?.[body.outputs.length - 1]?.text;
      if (!rawJson) return fast;
      const parsedAi = JSON.parse(rawJson);
      const validActions = (Array.isArray(parsedAi.actions) ? parsedAi.actions : []).filter((a) =>
        (a.type === 'all' && typeof a.state === 'boolean') ||
        (a.type === 'outlet' && [1, 2, 3, 4].includes(Number(a.id)) && typeof a.state === 'boolean')
      );

      if (!parsedAi.matched && !parsedAi.statusOnly) return fast;

      return {
        matched: Boolean(parsedAi.matched || parsedAi.statusOnly),
        statusOnly: Boolean(parsedAi.statusOnly),
        aiPowered: true,
        type: validActions[0]?.type || 'status',
        id: validActions[0]?.id,
        state: validActions[0]?.state,
        actions: validActions.map((a) => ({ type: a.type, id: a.id ? Number(a.id) : undefined, state: Boolean(a.state) })),
        spoken: rawTranscript,
        feedbackAr: parsedAi.feedbackAr || 'تم الفهم',
        feedbackEn: parsedAi.feedbackEn || 'Understood'
      };
    } catch (_) {
      return fast;
    }
  }
}

module.exports = new VoiceService();
