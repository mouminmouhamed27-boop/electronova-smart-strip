/**
 * Voice Command Parser & Processor (Arabic & English)
 * Translates speech transcripts into actionable IoT device commands.
 */
class VoiceService {
  constructor() {
    this.arabicNumbers = {
      'واحد': 1, 'واحده': 1, 'الاول': 1, 'الاولي': 1, '1': 1,
      'اثنين': 2, 'اتنين': 2, 'الثاني': 2, 'التاني': 2, 'التانيه': 2, '2': 2,
      'ثلاثة': 3, 'ثلاثه': 3, 'تلاتة': 3, 'تلاته': 3, 'الثالث': 3, 'التالت': 3, 'التالته': 3, '3': 3,
      'اربعة': 4, 'اربعه': 4, 'الرابع': 4, 'الرابعه': 4, '4': 4
    };

    this.outletAliases = {
      'راوتر': 1, 'الراوتر': 1, 'نت': 1, 'النت': 1, 'router': 1,
      'كمبيوتر': 2, 'الكمبيوتر': 2, 'بي سي': 2, 'pc': 2, 'computer': 2, 'شاشة': 2, 'الشاشة': 2, 'لابتوب': 2, 'laptop': 2,
      'لمبة': 3, 'اللمبة': 3, 'نور': 3, 'النور': 3, 'اضاءة': 3, 'اضاءه': 3, 'light': 3, 'lamp': 3,
      'شاحن': 4, 'الشاحن': 4, 'شواحن': 4, 'الشواحن': 4, 'charger': 4
    };
  }

  normalizeArabic(text) {
    const easternToWestern = text.replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
    return easternToWestern
      .toLowerCase()
      .replace(/[\u064B-\u065F\u0670\u0640]/g, '') // remove tashkeel & tatweel
      .replace(/[إأآا]/g, 'ا')
      .replace(/ة/g, 'ه')
      .replace(/ى/g, 'ي')
      .replace(/[^\w\s\u0621-\u064A0-9]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  parseCommand(rawTranscript) {
    if (!rawTranscript || typeof rawTranscript !== 'string') {
      return { matched: false, message: 'Empty or invalid voice transcript.' };
    }

    const raw = rawTranscript.trim();
    const cleanAr = this.normalizeArabic(raw);
    const cleanEn = raw
      .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
      .toLowerCase()
      .replace(/shut\s+down/g, 'shutdown')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // 1. Check Master Commands (All ON / All OFF)
    const isMasterOff =
      /(?:فصل|افصل|اطفي|طفي|اقفل|بند|اغلق|سكر)\s+(?:الكل|كله|كلها|الجميع)/.test(cleanAr) ||
      /\b(all off|turn off all|shutdown all|power off all|turn everything off|lights off|all of|olaf|hall of|shutdown)\b/.test(cleanEn);

    if (isMasterOff) {
      return {
        matched: true,
        type: 'all',
        state: false,
        spoken: raw,
        feedbackAr: 'تم فصل جميع المخارج بنجاح',
        feedbackEn: 'All outlets turned OFF successfully'
      };
    }

    const isMasterOn =
      /(?:شغل|افتح|ولع|نور)\s+(?:الكل|كله|كلها|الجميع)/.test(cleanAr) ||
      /\b(all on|turn on all|power on all|turn everything on|lights on)\b/.test(cleanEn);

    if (isMasterOn) {
      return {
        matched: true,
        type: 'all',
        state: true,
        spoken: raw,
        feedbackAr: 'تم تشغيل جميع المخارج بنجاح',
        feedbackEn: 'All outlets turned ON successfully'
      };
    }

    // 2. Determine Action (ON vs OFF)
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
        spoken: raw,
        message: 'Could not determine action (ON or OFF) from voice.'
      };
    }

    // 3. Find Outlet ID by number or alias
    let outletId = null;

    // By alias (normalized)
    for (const [alias, id] of Object.entries(this.outletAliases)) {
      const normAlias = this.normalizeArabic(alias);
      if (cleanAr.includes(normAlias) || cleanEn.includes(alias)) {
        outletId = id;
        break;
      }
    }

    // By Arabic Number (e.g. مخرج واحد، الفيشة التالتة، 2)
    if (!outletId) {
      for (const [word, id] of Object.entries(this.arabicNumbers)) {
        const rx = new RegExp(`(?:^|\\s)و?${word}(?:\\s|$)`);
        if (rx.test(cleanAr)) {
          outletId = id;
          break;
        }
      }
    }

    // By English Number / Digit
    if (!outletId) {
      const enNumMatch = cleanEn.match(/\b(1|one|first|won|2|two|second|3|three|third|tree|4|four|fourth|fore)\b/);
      if (enNumMatch) {
        const val = enNumMatch[1];
        if (['1', 'one', 'first', 'won'].includes(val)) outletId = 1;
        else if (['2', 'two', 'second'].includes(val)) outletId = 2;
        else if (['3', 'three', 'third', 'tree'].includes(val)) outletId = 3;
        else if (['4', 'four', 'fourth', 'fore'].includes(val)) outletId = 4;
      }
    }

    if (!outletId) {
      if (cleanAr.includes('الكل') || cleanAr.includes('كله') || cleanEn.includes('all')) {
        return {
          matched: true,
          type: 'all',
          state: targetState,
          spoken: raw,
          feedbackAr: `تم ${targetState ? 'تشغيل' : 'فصل'} جميع المخارج`,
          feedbackEn: `All outlets turned ${targetState ? 'ON' : 'OFF'}`
        };
      }

      return {
        matched: false,
        spoken: raw,
        message: 'Action found, but outlet number (1 to 4) was not detected.'
      };
    }

    return {
      matched: true,
      type: 'outlet',
      id: outletId,
      state: targetState,
      spoken: raw,
      feedbackAr: `تم ${targetState ? 'تشغيل' : 'فصل'} مخرج ${outletId} بنجاح`,
      feedbackEn: `Outlet ${outletId} turned ${targetState ? 'ON' : 'OFF'} successfully`
    };
  }
}

module.exports = new VoiceService();
