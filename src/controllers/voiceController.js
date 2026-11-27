const voiceService = require('../services/voiceService');
const mqttService = require('../services/mqttService');
const storage = require('../services/storageService');

exports.processVoiceCommand = async (req, res, next) => {
  try {
    const { transcript, language } = req.body || {};

    if (!transcript) {
      return res.status(400).json({
        success: false,
        message: 'Missing "transcript" field in request body.'
      });
    }

    // Parse via Gemini AI (if GEMINI_API_KEY configured) or dual-language parser
    const parsed = await voiceService.parseCommandWithAI(transcript);

    if (!parsed.matched) {
      return res.status(422).json({
        success: false,
        message: parsed.message || 'Command not recognized',
        spoken: transcript
      });
    }

    const actions = Array.isArray(parsed.actions) && parsed.actions.length > 0
      ? parsed.actions
      : (parsed.type === 'all' || parsed.type === 'outlet'
          ? [{ type: parsed.type, id: parsed.id, state: parsed.state }]
          : []);

    if (parsed.statusOnly || actions.length === 0) {
      const isAr = language === 'ar' || /[\u0600-\u06FF]/.test(transcript);
      const feedback = isAr ? parsed.feedbackAr : parsed.feedbackEn;
      return res.json({
        success: true,
        aiPowered: Boolean(parsed.aiPowered),
        mqttDispatched: false,
        message: feedback,
        feedbackSpeech: feedback,
        command: { type: 'status', actions: [] },
        deviceState: storage.getDeviceState()
      });
    }

    let commandResult = null;
    let executionError = null;
    let executionStatus = 403;

    try {
      for (const act of actions) {
        if (act.type === 'all') {
          commandResult = mqttService.setAllOutlets(act.state, 'ai_voice');
        } else if (act.type === 'outlet') {
          commandResult = mqttService.setOutletState(act.id, act.state, 'ai_voice');
        }
      }
    } catch (err) {
      commandResult = null;
      executionError = err.message;
      executionStatus = err.status || 403;
    }

    if (!commandResult) {
      return res.status(executionStatus).json({
        success: false,
        message: executionError || 'Command blocked by safety engine or device offline!',
        parsed
      });
    }

    const isAr = language === 'ar' || /[\u0600-\u06FF]/.test(transcript);
    const feedback = isAr ? parsed.feedbackAr : parsed.feedbackEn;

    return res.json({
      success: true,
      aiPowered: Boolean(parsed.aiPowered),
      mqttDispatched: commandResult.mqttDispatched,
      message: feedback,
      feedbackSpeech: feedback,
      command: {
        type: parsed.type,
        id: parsed.id || 'all',
        state: parsed.state,
        actions
      },
      deviceState: storage.getDeviceState()
    });
  } catch (err) {
    next(err);
  }
};
