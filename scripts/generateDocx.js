const fs = require('fs');
const path = require('path');
const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
  BorderStyle,
  AlignmentType,
  ShadingType
} = require('docx');

function createCell(text, widthPercent, isHeader = false, isCode = false) {
  return new TableCell({
    width: { size: widthPercent, type: WidthType.PERCENTAGE },
    shading: isHeader ? { fill: "1E293B", type: ShadingType.CLEAR } : undefined,
    children: [
      new Paragraph({
        children: [
          new TextRun({
            text: text,
            bold: isHeader,
            color: isHeader ? "FFFFFF" : (isCode ? "0284C7" : "0F172A"),
            font: isCode ? "Consolas" : "Calibri",
            size: isHeader ? 20 : 18
          })
        ]
      })
    ]
  });
}

function createCodeBlock(codeLines) {
  return codeLines.map(line =>
    new Paragraph({
      children: [
        new TextRun({
          text: line,
          font: "Consolas",
          size: 17,
          color: "0F172A"
        })
      ],
      spacing: { line: 240 }
    })
  );
}

function buildEndpointSection(title, method, pathStr, authRequired, desc, requestBody, responseBody, notes) {
  const methodColor = method === 'GET' ? '16A34A' : (method === 'POST' ? '0284C7' : 'D97706');
  
  const elements = [
    new Paragraph({
      heading: HeadingLevel.HEADING_2,
      children: [
        new TextRun({ text: `[${method}] `, bold: true, color: methodColor, font: "Consolas" }),
        new TextRun({ text: pathStr, bold: true, font: "Consolas" }),
        new TextRun({ text: authRequired ? "  (Requires Bearer Token)" : "  (Public)", italic: true, size: 18, color: "64748B" })
      ],
      spacing: { before: 240, after: 80 }
    }),
    new Paragraph({
      children: [
        new TextRun({ text: "Description: ", bold: true }),
        new TextRun({ text: desc })
      ],
      spacing: { after: 120 }
    })
  ];

  if (requestBody) {
    elements.push(
      new Paragraph({
        children: [new TextRun({ text: "Request Body (application/json):", bold: true, size: 18, color: "334155" })],
        spacing: { after: 40 }
      }),
      ...createCodeBlock(requestBody.split('\n'))
    );
  }

  if (responseBody) {
    elements.push(
      new Paragraph({
        children: [new TextRun({ text: "Response (200 OK):", bold: true, size: 18, color: "334155" })],
        spacing: { before: 80, after: 40 }
      }),
      ...createCodeBlock(responseBody.split('\n'))
    );
  }

  if (notes) {
    elements.push(
      new Paragraph({
        children: [
          new TextRun({ text: "Technical Notes: ", bold: true, color: "B45309" }),
          new TextRun({ text: notes, italic: true, color: "78350F" })
        ],
        spacing: { before: 80, after: 160 }
      })
    );
  }

  return elements;
}

async function generate() {
  const doc = new Document({
    sections: [
      {
        properties: {},
        children: [
          // Title
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new TextRun({
                text: "ElectroNova Smart Power Strip v4.2",
                bold: true,
                size: 40,
                color: "0369A1",
                font: "Calibri"
              })
            ],
            spacing: { before: 200, after: 100 }
          }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new TextRun({
                text: "RESTful & WebSocket Application Programming Interface (API) Specification",
                size: 26,
                color: "334155",
                bold: true,
                font: "Calibri"
              })
            ],
            spacing: { after: 80 }
          }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new TextRun({
                text: "Software Interface Specification & Integration Manual for Mobile (Flutter) & Web Clients",
                italic: true,
                size: 20,
                color: "64748B"
              })
            ],
            spacing: { after: 400 }
          }),

          // Metadata Table
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [
              new TableRow({
                children: [createCell("Document Version", 30, true), createCell("1.0.0 (Standard Production)", 70)]
              }),
              new TableRow({
                children: [createCell("Specification Standard", 30, true), createCell("OpenAPI 3.0 / RFC 7231 (HTTP/1.1) / RFC 6455 (WebSocket)", 70)]
              }),
              new TableRow({
                children: [createCell("Base URL (Local)", 30, true), createCell("http://localhost:5000/api", 70, false, true)]
              }),
              new TableRow({
                children: [createCell("WebSocket Stream", 30, true), createCell("ws://localhost:5000/ws/telemetry", 70, false, true)]
              }),
              new TableRow({
                children: [createCell("Interactive Swagger UI", 30, true), createCell("http://localhost:5000/api-docs", 70, false, true)]
              }),
              new TableRow({
                children: [createCell("Authentication", 30, true), createCell("JSON Web Token (JWT) Bearer Token (RFC 6750)", 70)]
              }),
              new TableRow({
                children: [createCell("Institution", 30, true), createCell("Faculty of Engineering, Al-Azhar University (Cairo)", 70)]
              })
            ]
          }),

          new Paragraph({ spacing: { after: 400 } }),

          // Section 1
          new Paragraph({
            heading: HeadingLevel.HEADING_1,
            children: [new TextRun({ text: "1. Architectural Overview & Protocols", bold: true, color: "0369A1" })],
            spacing: { before: 200, after: 120 }
          }),
          new Paragraph({
            children: [
              new TextRun({
                text: "The ElectroNova IoT ecosystem is built on a decoupled, three-tier architecture: Embedded Hardware (ESP32), Application Middleware Server (Node.js/Express), and Client Presentation Interfaces (Flutter Mobile App & Web Dashboard). Direct client communication with the hardware is prohibited for security and safety enforcement. The Node.js server acts as an authoritative proxy, validating client permissions, enforcing safety heuristics (overheat trip and load shedding), and relaying commands to the ESP32 via MQTT."
              })
            ],
            spacing: { after: 200 }
          }),

          // Section 2
          new Paragraph({
            heading: HeadingLevel.HEADING_1,
            children: [new TextRun({ text: "2. Standard Response & Error Envelopes", bold: true, color: "0369A1" })],
            spacing: { before: 200, after: 120 }
          }),
          new Paragraph({
            children: [
              new TextRun({
                text: "All HTTP responses conform to strict JSON envelopes. Clients must inspect the top-level 'success' boolean flag."
              })
            ],
            spacing: { after: 100 }
          }),
          new Paragraph({
            children: [new TextRun({ text: "Success Envelope Example:", bold: true, size: 18 })]
          }),
          ...createCodeBlock([
            '{',
            '  "success": true,',
            '  "message": "Operation completed successfully",',
            '  "data": { ... }',
            '}'
          ]),
          new Paragraph({
            children: [new TextRun({ text: "Error Envelope Example (e.g. 403 Forbidden - Safety Trip):", bold: true, size: 18 })],
            spacing: { before: 100 }
          }),
          ...createCodeBlock([
            '{',
            '  "success": false,',
            '  "message": "Action rejected: Overheat lock is active (>65°C)!",',
            '  "error": "SAFETY_LOCK_OVERHEAT"',
            '}'
          ]),

          // Section 3: Auth Endpoints
          new Paragraph({
            heading: HeadingLevel.HEADING_1,
            children: [new TextRun({ text: "3. Authentication & User Management (JWT)", bold: true, color: "0369A1" })],
            spacing: { before: 300, after: 120 }
          }),
          ...buildEndpointSection(
            "User Login",
            "POST",
            "/api/auth/login",
            false,
            "Authenticates credentials and returns a signed JSON Web Token valid for 7 days.",
            '{\n  "email": "admin@electronova.local",\n  "password": "your_password"\n}',
            '{\n  "success": true,\n  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",\n  "user": {\n    "id": "admin_1",\n    "name": "Project Lead",\n    "email": "admin@electronova.local",\n    "role": "owner"\n  }\n}',
            "Default testing credentials: admin@electronova.local / 123456"
          ),
          ...buildEndpointSection(
            "Register New User",
            "POST",
            "/api/auth/register",
            false,
            "Provisions a new user profile with encrypted password hashing (bcrypt).",
            '{\n  "name": "Ahmed Salem",\n  "email": "ahmed@example.com",\n  "password": "secure_password"\n}',
            '{\n  "success": true,\n  "message": "Account created successfully",\n  "token": "jwt_token_string",\n  "user": { "id": "usr_1732", "name": "Ahmed Salem", "role": "member" }\n}',
            "Returns 409 Conflict if email is already registered."
          ),
          ...buildEndpointSection(
            "Current User Session",
            "GET",
            "/api/auth/me",
            true,
            "Returns profile information for the authenticated token.",
            null,
            '{\n  "success": true,\n  "user": { "id": "admin_1", "name": "Project Lead", "role": "owner" }\n}'
          ),

          // Section 4: Outlets
          new Paragraph({
            heading: HeadingLevel.HEADING_1,
            children: [new TextRun({ text: "4. Device & Outlet Control Subsystem", bold: true, color: "0369A1" })],
            spacing: { before: 300, after: 120 }
          }),
          ...buildEndpointSection(
            "Get All Outlets Status",
            "GET",
            "/api/outlets",
            true,
            "Fetches live state, individual current draw, wattage, and total kWh for all four outlets.",
            null,
            '{\n  "success": true,\n  "outlets": [\n    { "id": 1, "name": "Router (P1 Critical)", "priority": 1, "state": true, "currentAmps": 1.1, "currentWatts": 242, "totalKwh": 0.450 },\n    { "id": 2, "name": "Workstation (P2 High)", "priority": 2, "state": false, "currentAmps": 0.0, "currentWatts": 0, "totalKwh": 1.200 },\n    { "id": 3, "name": "Lab Lighting (P3 Medium)", "priority": 3, "state": true, "currentAmps": 0.5, "currentWatts": 110, "totalKwh": 0.150 },\n    { "id": 4, "name": "Auxiliary/Chargers (P4 Low)", "priority": 4, "state": false, "currentAmps": 0.0, "currentWatts": 0, "totalKwh": 0.080 }\n  ],\n  "safety": { "temperatureC": 28.4, "totalAmps": 1.6, "isOverheatLocked": false, "alert": "OK" }\n}'
          ),
          ...buildEndpointSection(
            "Control Specific Outlet",
            "POST",
            "/api/outlets/:id",
            true,
            "Toggles specified outlet (1 to 4) ON or OFF. Validated against safety thresholds.",
            '{\n  "state": true\n}',
            '{\n  "success": true,\n  "message": "Outlet 1 set to ON",\n  "outlet": { "id": 1, "state": true }\n}',
            "Returns 403 Forbidden if safety lock is active (>65°C or >16A overload). Turning OFF (state: false) is always permitted."
          ),
          ...buildEndpointSection(
            "Master Power Control",
            "POST",
            "/api/outlets/all",
            true,
            "Simultaneously switches all four outlets ON or OFF.",
            '{\n  "state": false\n}',
            '{\n  "success": true,\n  "message": "All outlets set to OFF"\n}'
          ),
          ...buildEndpointSection(
            "Set Countdown Timer",
            "POST",
            "/api/outlets/:id/timer",
            true,
            "Arms a one-shot countdown timer on an outlet to invert its current state after delaySec.",
            '{\n  "delaySec": 60\n}',
            '{\n  "success": true,\n  "message": "Countdown timer set for Outlet 2: 60 seconds"\n}'
          ),

          // Section 5: Voice
          new Paragraph({
            heading: HeadingLevel.HEADING_1,
            children: [new TextRun({ text: "5. Natural Language Voice Processing Engine", bold: true, color: "0369A1" })],
            spacing: { before: 300, after: 120 }
          }),
          ...buildEndpointSection(
            "Execute Voice Command",
            "POST",
            "/api/voice/command",
            true,
            "Submits an audio speech transcript (Arabic or English). The server's Natural Language Processing (NLP) parser resolves device aliases, maps intended state, dispatches the hardware command, and provides localized audio feedback text.",
            '{\n  "transcript": "شغل الراوتر",\n  "language": "ar"\n}',
            '{\n  "success": true,\n  "message": "تم تشغيل مخرج 1 بنجاح",\n  "feedbackSpeech": "تم تشغيل مخرج 1 بنجاح",\n  "command": {\n    "type": "outlet",\n    "id": 1,\n    "state": true\n  }\n}',
            "Supported aliases: الراوتر / النت -> Outlet 1; الكمبيوتر / الشاشة -> Outlet 2; النور / الإضاءة -> Outlet 3; الشاحن -> Outlet 4. English queries ('turn on router', 'all off') are fully supported."
          ),

          // Section 6: Safety
          new Paragraph({
            heading: HeadingLevel.HEADING_1,
            children: [new TextRun({ text: "6. Autonomous Hardware Safety & Protection", bold: true, color: "0369A1" })],
            spacing: { before: 300, after: 120 }
          }),
          ...buildEndpointSection(
            "Safety Engine Status & Trip Thresholds",
            "GET",
            "/api/safety/status",
            false,
            "Returns real-time thermal/current metrics and active safety lockout states.",
            null,
            '{\n  "success": true,\n  "safety": {\n    "temperatureC": 28.5,\n    "totalAmps": 3.4,\n    "totalWatts": 748,\n    "isOverheatLocked": false,\n    "isOverloadBlocked": false,\n    "alert": "OK",\n    "thresholds": {\n      "overheatTripTempC": 65.0,\n      "overheatResetTempC": 60.0,\n      "maxRatedAmps": 16.0,\n      "loadShedThresholdAmps": 15.5\n    }\n  }\n}'
          ),
          ...buildEndpointSection(
            "Manual Safety Lock Release",
            "POST",
            "/api/safety/unlock",
            true,
            "Manually resets the overheat lockout after enclosure temperature has cooled below 60°C.",
            null,
            '{\n  "success": true,\n  "message": "Safety lock manually reset."\n}',
            "Returns 400 Bad Request if temperature is still above 60.0°C."
          ),
          ...buildEndpointSection(
            "Sequential Power Restore",
            "POST",
            "/api/safety/sequential-restore",
            true,
            "Executes an automated, staggered activation sequence (default: 3000ms delay between outlets) to protect building circuit breakers from high inrush currents upon AC mains restoration.",
            '{\n  "delayMs": 3000\n}',
            '{\n  "success": true,\n  "message": "Sequential power restore initiated (3000ms delay between outlets)."\n}'
          ),

          // Section 7: Telemetry & Analytics
          new Paragraph({
            heading: HeadingLevel.HEADING_1,
            children: [new TextRun({ text: "7. Telemetry, Billing & Analytics Infrastructure", bold: true, color: "0369A1" })],
            spacing: { before: 300, after: 120 }
          }),
          ...buildEndpointSection(
            "Real-Time Telemetry",
            "GET",
            "/api/telemetry/live",
            false,
            "Returns the latest sensor packet received from the power strip.",
            null,
            '{\n  "success": true,\n  "device": {\n    "id": "strip_azhar_01",\n    "isOnline": true,\n    "lastHeartbeat": "2026-11-22T17:30:00Z",\n    "safety": { "temperatureC": 31.0, "totalWatts": 850, "totalAmps": 3.86, "alert": "OK" },\n    "outlets": [ ... ]\n  }\n}'
          ),
          ...buildEndpointSection(
            "Energy & Financial Billing Summary",
            "GET",
            "/api/analytics/energy",
            true,
            "Aggregates cumulative energy (kWh), total expenditure in Egyptian Pounds (EGP), per-outlet consumption ratios, and projected monthly cost.",
            null,
            '{\n  "success": true,\n  "data": {\n    "tariffPerKwh": 1.25,\n    "currency": "EGP",\n    "cumulativeKwh": 8.420,\n    "totalCostEgp": 10.53,\n    "metrics": {\n      "peakWattsRecorded": 2400,\n      "averageWatts": 650,\n      "projectedMonthlyKwh": 468.0,\n      "projectedMonthlyCostEgp": 585.0\n    },\n    "outlets": [\n      { "id": 1, "name": "Router", "totalKwh": 2.10, "costEgp": 2.63, "sharePercentage": 24.9 },\n      { "id": 2, "name": "Workstation", "totalKwh": 4.50, "costEgp": 5.63, "sharePercentage": 53.4 }\n    ]\n  }\n}'
          ),

          // Section 8: WebSocket
          new Paragraph({
            heading: HeadingLevel.HEADING_1,
            children: [new TextRun({ text: "8. WebSocket Real-Time Telemetry Protocol", bold: true, color: "0369A1" })],
            spacing: { before: 300, after: 120 }
          }),
          new Paragraph({
            children: [
              new TextRun({ text: "Endpoint: ", bold: true }),
              new TextRun({ text: "ws://localhost:5000/ws/telemetry", font: "Consolas", color: "0369A1" })
            ],
            spacing: { after: 100 }
          }),
          new Paragraph({
            children: [
              new TextRun({
                text: "Upon connection establishment, the server transmits an 'init' message with full device state. Whenever a telemetry frame arrives from the ESP32 via MQTT, the server broadcasts a 'telemetry_update' event to all subscribed WebSocket clients without polling latency."
              })
            ],
            spacing: { after: 100 }
          }),
          ...createCodeBlock([
            '// On Incoming Message Frame:',
            '{',
            '  "type": "telemetry_update",',
            '  "data": {',
            '    "safety": { "temperatureC": 31.4, "totalAmps": 4.2, "totalWatts": 924, "alert": "OK" },',
            '    "outlets": [ ... ]',
            '  }',
            '}'
          ]),

          // Section 9: Flutter Implementation snippet
          new Paragraph({
            heading: HeadingLevel.HEADING_1,
            children: [new TextRun({ text: "9. Mobile App (Flutter / Dart) Integration Snippet", bold: true, color: "0369A1" })],
            spacing: { before: 300, after: 120 }
          }),
          ...createCodeBlock([
            'import "dart:convert";',
            'import "package:http/http.dart" as http;',
            '',
            'class ElectroNovaClient {',
            '  static const String baseUrl = "http://localhost:5000/api";',
            '  String? token;',
            '',
            '  Future<bool> login(String email, String password) async {',
            '    final res = await http.post(',
            '      Uri.parse("$baseUrl/auth/login"),',
            '      headers: {"Content-Type": "application/json"},',
            '      body: jsonEncode({"email": email, "password": password}),',
            '    );',
            '    if (res.statusCode == 200) {',
            '      token = jsonDecode(res.body)["token"];',
            '      return true;',
            '    }',
            '    return false;',
            '  }',
            '',
            '  Future<bool> setOutlet(int id, bool state) async {',
            '    final res = await http.post(',
            '      Uri.parse("$baseUrl/outlets/$id"),',
            '      headers: {',
            '        "Content-Type": "application/json",',
            '        "Authorization": "Bearer $token",',
            '      },',
            '      body: jsonEncode({"state": state}),',
            '    );',
            '    return res.statusCode == 200;',
            '  }',
            '}'
          ])
        ]
      }
    ]
  });

  const buffer = await Packer.toBuffer(doc);
  
  // Save to Downloads folder
  const downloadsPath = "C:\\Users\\dell\\Downloads\\ElectroNova-API-Specification.docx";
  fs.writeFileSync(downloadsPath, buffer);
  console.log("✅ Word Document generated at:", downloadsPath);

  // Save to project root folder
  const projectDocxPath = path.join(__dirname, "../../ElectroNova-API-Specification.docx");
  fs.writeFileSync(projectDocxPath, buffer);
  console.log("✅ Word Document generated at:", projectDocxPath);
}

generate().catch(err => {
  console.error("Error generating docx:", err);
  process.exit(1);
});
