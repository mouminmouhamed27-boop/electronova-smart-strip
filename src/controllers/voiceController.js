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

    // Parse the spoken text using our dual-language NLP parser
    const parsed = voiceService.parseCommand(transcript);

    if (!parsed.matched) {
      return res.status(422).json({
        success: false,
        message: parsed.message || 'Command not recognized',
        spoken: transcript
      });
    }

    // Execute the command via MQTT
    let commandResult = null;
    let executionError = null;

    try {
      if (parsed.type === 'all') {
        commandResult = mqttService.setAllOutlets(parsed.state);
      } else if (parsed.type === 'outlet') {
        commandResult = mqttService.setOutletState(parsed.id, parsed.state);
      }
    } catch (err) {
      commandResult = null;
      executionError = err.message;
    }

    if (!commandResult) {
      return res.status(403).json({
        success: false,
        message: executionError || 'Command blocked by safety engine (Overheat or Overload)!',
        parsed
      });
    }

    // Determine localized feedback
    const isAr = language === 'ar' || /[\u0600-\u06FF]/.test(transcript);
    const feedback = isAr ? parsed.feedbackAr : parsed.feedbackEn;

    return res.json({
      success: true,
      mqttDispatched: commandResult.mqttDispatched,
      message: feedback,
      feedbackSpeech: feedback,
      command: {
        type: parsed.type,
        id: parsed.id || 'all',
        state: parsed.state
      },
      deviceState: storage.getDeviceState()
    });
  } catch (err) {
    next(err);
  }
};
