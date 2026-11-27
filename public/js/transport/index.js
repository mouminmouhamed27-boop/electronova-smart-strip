/**
 * Transport Factory (selects backend | mock | mqtt | ws)
 */

import { createBackendTransport } from './backend.js';
import { createMockTransport } from './mock.js';
import { createMqttTransport } from './mqtt.js';
import { createWsTransport } from './ws.js';

export function createTransport(config, handlers) {
  switch (config.transport) {
    case 'mock':
      return createMockTransport(config, handlers);
    case 'mqtt':
      return createMqttTransport(config, handlers);
    case 'ws':
      return createWsTransport(config, handlers);
    case 'backend':
    default:
      return createBackendTransport(config, handlers);
  }
}
