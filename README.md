# ⚡ ElectroNova — Smart Power Strip (Full-Stack + Modular ES Frontend)
## النظام المتكامل للمشترك الكهربائي الذكي — هندسة الأزهر

مشروع **ElectroNova** يضم Backend متكامل بـ **Node.js + Express** (متصل بـ **EMQX Cloud SSL**) مع واجهة ويب معمارية مبنية بـ **Vanilla ES Modules + Pure CSS Design Tokens + SVG Chart** بدون أي Build Tools.

---

### 📁 هيكل المشروع

```
electronova/
├─ src/                         # Express Backend + MQTT + Safety Engine + Cron + Voice NLP
├─ public/                      # Modular Static Frontend (يُخدم تلقائياً من السيرفر أو أي استضافة)
│  ├─ index.html                # واجهة RTL بـ 4 شاشات + شريط صوت عائم + Dark/Light Theme
│  ├─ css/
│  │  ├─ tokens.css             # ألوان (#060b16 / #22d3ee / #34d399) + Light theme tokens
│  │  ├─ base.css               # Shell layout (Mobile Bottom Nav + Desktop Side Rail >= 900px)
│  │  └─ components.css         # Glassmorphism cards, Ring Gauge, Switches, Voice Dock, Modals
│  └─ js/
│     ├─ main.js                # Bootstrap
│     ├─ config.js              # الإعدادات + URL params (?mock=1) + localStorage
│     ├─ strings.js             # النصوص العربية وبيانات المخارج
│     ├─ core/                  # store.js, protocol.js, safety.js, controller.js
│     ├─ transport/             # backend.js (افتراضي) | mock.js | mqtt.js | ws.js
│     ├─ voice/                 # parser.js (pure), engine.js, router.js, beep.js
│     └─ ui/                    # render.js, router.js, outletCards.js, chart.js (SVG), energyView.js, voiceDock.js, settings.js, toast.js
├─ tests/
│  └─ parser.test.mjs           # اختبارات الـ Voice Parser وقواعد الأمان والبروتوكول
└─ package.json
```

---

### 🚀 التشغيل محلياً (Quickstart)

#### 1) تشغيل Full-Stack (Backend + Frontend معاً):
```bash
npm install
npm start
```
- الداشبورد: `http://localhost:5000/`
- محاكي الهاردوير بدون ESP32 أو Backend عبر الرابط: `http://localhost:5000/?mock=1`
- توثيق API التفاعلي (Swagger): `http://localhost:5000/api-docs`

#### 2) تشغيل الواجهة Static فقط (للتجربة مع Mock أو MQTT مباشر):
```bash
npx serve public
# أو
python -m http.server 8080 --directory public
```
ثم افتح `http://localhost:8080/?mock=1` واختبر الحماية من الـ Console:
```js
window.__mock.setTemp(70);     // يفعّل قفل الحرارة > 65°C ويمنع ON
window.__mock.setTemp(55);     // يفك القفل < 60°C
window.__mock.setLoad(2, 18);  // يفعّل فصل الأحمال الزائدة > 16A
```

---

### 🧪 تشغيل الاختبارات

```bash
node --test tests/parser.test.mjs
```

---

### 🔌 كيفية إضافة Transport جديد

كل محول اتصال في `public/js/transport/` يرجّع نفس الواجهة القياسية:

```js
export function createCustomTransport(config, handlers) {
  return {
    type: 'custom',
    connect() {
      // استدعِ handlers.onStatus('connecting' | 'connected' | 'disconnected')
      // عند وصول قراءة: handlers.onMessage({ kind: 'telemetry' | 'lwt', data, text, retained })
    },
    disconnect() {},
    publish(cmdObj) { return true; },
    isConnected() { return true; }
  };
}
```
أضفه في `public/js/transport/index.js` وفي قائمة `#cfgTransport` في `public/index.html`.

---

### 📡 بروتوكول الاتصال الموحد (Backend & ESP32)

- **Topics:** `electronova/{deviceId}/cmd` | `electronova/{deviceId}/state` | `electronova/{deviceId}/status`
- **الأوامر:** `{"type":"outlet","id":1,"state":true}` · `{"type":"all","state":false}` · `{"type":"sync"}` · `{"type":"schedule","id":1,"enabled":true,"on":"08:00","off":"23:00"}` · `{"type":"timer","id":1,"state":true,"delaySec":60}` · `{"type":"resetEnergy"}`
- **قواعد الأمان:** فصل تلقائي عند حرارة ≥ 65°C (يُفك < 60°C)، وفصل الأحمال بالتدريج عند تيار > 16A (`P4 ← P3 ← P2`)، وأوامر الفصل (`OFF`) مسموحة دائماً.
