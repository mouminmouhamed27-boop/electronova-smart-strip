/**
 * Dynamic UI Strings & Outlet Metadata (Arabic RTL)
 */

export const OUTLET_META = [
  { id: 1, name: 'مخرج 1', code: 'OUT-1', desc: 'راوتر / جهاز أساسي', badge: 'P1 Top', badgeClass: 'badge-p1' },
  { id: 2, name: 'مخرج 2', code: 'OUT-2', desc: 'كمبيوتر / محطة عمل', badge: 'P2 High', badgeClass: 'badge-p2' },
  { id: 3, name: 'مخرج 3', code: 'OUT-3', desc: 'إضاءة المعمل / طرفيات', badge: 'P3 Med', badgeClass: 'badge-p3' },
  { id: 4, name: 'مخرج 4', code: 'OUT-4', desc: 'أحمال غير حرجة / شواحن', badge: 'P4 Low', badgeClass: 'badge-p4' }
];

export const STRINGS = {
  espOnline: 'ESP32: متصل',
  espOffline: 'ESP32: منقطع',
  espWaiting: 'ESP32: انتظار',
  cloudConnected: 'السحابة: متصل',
  cloudConnecting: 'السحابة: اتصال...',
  cloudDisconnected: 'السحابة: منقطع',
  onLabel: 'يعمل (ON)',
  offLabel: 'مغلق (OFF)',
  overheatOutletLabel: '🔒 محظور (حرارة)',
  overloadOutletLabel: '⚡ محظور (حمل)',
  sensorFaultOutletLabel: '🚨 عطل حساس',
  latchedOutletLabel: '🔒 قفل دائم (3 فصلات)',
  masterOnNormal: 'تشغيل الكل',
  masterOnOverheat: 'محظور (حرارة عالية)',
  masterOnOverload: 'محظور (حمل > 16A)',
  masterOnSensorFault: 'محظور (عطل حساس)',
  masterOnLatched: 'قفل دائم (افحص الأحمال)',
  overheatBanner: 'حماية الحرارة (> 65°C): تم فصل جميع المخارج وقفل التشغيل حتى تنخفض الحرارة أقل من 60°C — أوامر الفصل متاحة دائماً.',
  overloadBanner: (alertCode) => `زيادة حمل (> 16A): تم تخفيف الحمل تلقائياً (${alertCode}) — يمكنك إعادة التشغيل فور انخفاض التيار.`,
  sensorFaultBanner: '🚨 عطل حساس (DS18B20 أو ACS712 غير متصل): تم فصل جميع المخارج وقفله لحين توصيل الحساسات بشكل سليم.',
  latchedBanner: '🔒 قفل دائم للتيار الزائد (3 فصلات متتالية): افصل الأحمال الخطرة أولاً ثم اضغط فك القفل يدوياً.',
  voltageBanner: (v) => `تحذير جهد غير مستقر (${v.toFixed(1)}V AC): خارج النطاق الآمن 190V–250V.`,
  blockedToast: (reason) => `تم الحظر: ${reason}`,
  authRequired: 'سجّل الدخول أولاً لتنفيذ هذا الإجراء عبر الـ Backend.'
};
