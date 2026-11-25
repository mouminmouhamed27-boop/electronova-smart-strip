# ⚡ ElectroNova Backend Server
## خادم السحابة للمشترك الكهربائي الذكي — هندسة الأزهر

خادم خلفي متكامل بمواصفات عالمية مبني بـ **Node.js + Express**، مخصص للربط المباشر مع تطبيق الموبايل (Flutter)، لوحات التحكم (Web)، ووحدة الـ ESP32.

---

### 🌟 أهم مميزات ومحركات اللوجيك (Engines):

1. **محرك الأوامر الصوتية الذكي (Dual-Language Voice NLP Engine):**
   - يدعم العربية الفصحى والعامية المصرية والإنجليزية (`/api/voice/command`).
   - يتعرف على الأرقام وأسماء الأجهزة: "شغل الراوتر" (مخرج 1)، "اطفي الشواحن" (مخرج 4)، "افصل الكل"، "Turn on 2", "All off".
   - يرجع رداً صوتياً ونصياً جاهزاً لتطبيق الفلاتر (`feedbackSpeech`).

2. **محرك حماية الأمان وفصل الأحمال (Hardware Safety & Load Shedding Engine):**
   - **حماية الحرارة:** فصل فوري عند تخطي 65°C مع قفل الأمان (Lockout)، ولا يسمح بالتشغيل إلا بعد تبريد العلبة تحت 60°C.
   - **فصل الأحمال بالترتيب (Priority Load Shedding):** عند اقتراب التيار من 16A، يفصل المخرج ذو الأولوية الأقل (P4 ثم P3)، ولا يمس المخرج الحرج (P1 كالراوتر).
   - **منع تيار الاندفاع (Sequential Power Restore):** تشغيل المخارج بتسلسل زمني (فاصل 3 ثوانٍ) لحماية قاطع المنزل من الانهيار.

3. **محرك الأتمتة والجدولة الزمني (Cron Automation Engine):**
   - فحص دوري كل دقيقة لتنفيذ الجداول اليومية حتى لو انقطع الـ NTP عن الـ ESP32.

4. **الربط السحابي الموحد عبر EMQX Cloud (MQTTS 8883):**
   - موحّد مع تطبيق الأندرويد والـ ESP32 (بروتوكول `electronova/{deviceId}/cmd|state|status`، المعرف الافتراضي `EN_SIM1`).
   - يدعم التوافق التام مع الصيغ الموحدة (`outlets, temp, amps, watts, alert`) والقديمة (`v4.0`) وحساب الـ `kWh` التلقائي عند عدم إرساله من المحاكي.

5. **محرك تحليلات الطاقة وحساب الفاتورة (Energy & Billing Analytics):**
   - حساب إجمالي الكيلوواط/ساعة والفاتورة بالجنيه المصري (تعريفة قابلة للتعديل).
   - توزيع الاستهلاك لكل مخرج بالنسبة المئوية وتوقع الاستهلاك الشهري.

6. **توثيق تفاعلي كامل عبر Swagger / OpenAPI 3.0 (`/api-docs`):**
   - واجهة تجربة حية لكل الـ Endpoints جاهزة فوراً.

7. **بث حي عبر WebSocket (`/ws/telemetry`):**
   - بث فوري بدون أي تأخير (Zero-latency) لكل قراءات الجهد والأمبير والواط والحرارة وحالات الطوارئ (`OVERHEAT` / `OVERLOAD`).

---

### 🚀 تشغيل المشروع محلياً (Quickstart)

```bash
npm install
npm start
```

- **لوحة التحكم (Frontend Unified):** `http://localhost:5000/`
- **رابط التوثيق التفاعلي (Swagger UI):** `http://localhost:5000/api-docs`
- **نقطة الـ API الأساسية:** `http://localhost:5000/api`
- **بث WebSocket المباشر:** `ws://localhost:5000/ws/telemetry`
- **فحص الجاهزية (Healthcheck):** `GET http://localhost:5000/health`

---

### ☁️ النشر على استضافة Render.com (Full-Stack Free Hosting)

المشروع موحّد بالكامل في هذا المجلد وجاهز للرفع على Render عبر ملف `render.yaml`:
1. ارفع محتويات مجلد `electronova` إلى مستودع GitHub خاص بك.
2. في [Render.com](https://render.com) اختر **New -> Blueprint** (أو **Web Service**).
3. اربط مستودع GitHub وأدخل متغيرات البيئة السرية (`MQTT_USERNAME` و `MQTT_PASSWORD`).
4. سيعمل السيرفر والواجهة وWebSocket وEMQX Cloud MQTTS على رابط واحد آمن (`https://your-app.onrender.com`).

---

### 🔑 بيانات الدخول الافتراضية للتجربة (Default Admin)

- **البريد الإلكتروني:** `admin@electronova.local`
- **كلمة المرور:** `123456`

---

### 📡 الدليل المرجعي الكامل لمطور تطبيق الفلاتر (API Endpoints Reference)

| القسم | المسار | الطريقة | الوصف والمدخلات | الحماية |
|---|---|---|---|---|
| **المصادقة** | `/api/auth/login` | `POST` | تسجيل الدخول `{ email, password }` ← يرجع `token` | مفتوح |
| | `/api/auth/register` | `POST` | تسجيل حساب جديد `{ name, email, password }` | مفتوح |
| | `/api/auth/me` | `GET` | بيانات المستخدم الحالي | `Bearer Token` |
| **التحكم بالمخارج** | `/api/outlets` | `GET` | قائمة المخارج الأربعة مع حالاتها وقياساتها | `Bearer Token` |
| | `/api/outlets/:id` | `POST` | تشغيل/فصل مخرج محدد `{ state: true/false }` | `Bearer Token` |
| | `/api/outlets/all` | `POST` | ماستر تشغيل/فصل الكل `{ state: true/false }` | `Bearer Token` |
| | `/api/outlets/:id/timer`| `POST` | مؤقت عد تنازلي `{ delaySec: 60 }` | `Bearer Token` |
| **الأوامر الصوتية** | `/api/voice/command` | `POST` | معالجة الصوت: `{ transcript: "شغل الراوتر", language: "ar" }` | `Bearer Token` |
| **الأمان والحماية** | `/api/safety/status` | `GET` | فحص درجات الحرارة وعتبات الفصل وحدود التيار | مفتوح |
| | `/api/safety/unlock` | `POST` | فك قفل الأمان يدوياً بعد تبريد الجهاز | `Bearer Token` |
| | `/api/safety/sequential-restore` | `POST` | تشغيل متسلسل تدريجي بعد عودة الكهرباء لمنع القفلة | `Bearer Token` |
| **التحليلات والفاتورة**| `/api/analytics/energy` | `GET` | إحصائيات استهلاك الطاقة التراكمية، الواط الأقصى، وتكلفة الفاتورة | `Bearer Token` |
| **المقاييس الحية** | `/api/telemetry/live` | `GET` | القراءات اللحظية الحالية من الحساسات وحالة الاتصال والـ Topics | مفتوح |
| | `/api/telemetry/history`| `GET` | قراءات سابقة لرسم بياني في التطبيق | مفتوح |
| | `/api/telemetry/logs` | `GET` | سجل الأحداث والعمليات | `Bearer Token` |
| | `/api/telemetry/energy/reset` | `POST` | تصفير عداد الطاقة | `Bearer Token` |
| | `/api/telemetry/sync` | `POST` | إرسال طلب مزامنة فورية `{"type":"sync"}` للـ ESP32 | `Bearer Token` |
| | `/api/telemetry/device` | `POST` | تبديل معرف الجهاز النشط `{ deviceId: "EN_SIM1" }` ديناميكياً | `Bearer Token` |
| **الجداول** | `/api/schedules` | `GET` | استعراض جداول التشغيل اليومية | `Bearer Token` |
| | `/api/schedules/:id` | `POST` | حفظ جدول لمخرج `{ enabled, onTime, offTime }` | `Bearer Token` |
