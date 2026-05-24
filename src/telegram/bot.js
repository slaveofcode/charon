import TelegramBot from 'node-telegram-bot-api';
import { TELEGRAM_BOT_TOKEN } from '../config.js';

let botInstance = null;
let retryTimer = null;
const readyCallbacks = [];

/**
 * Register a callback that fires when the bot instance is created/recreated.
 * Used by setupTelegram() to re-attach event listeners after polling retry.
 */
export function onBotReady(fn) {
  readyCallbacks.push(fn);
}

function createBot() {
  if (botInstance) {
    try { botInstance.stopPolling(); } catch {}
    botInstance = null;
  }

  const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, {
    polling: {
      interval: 300,
      autoStart: true,
      params: { timeout: 10 },
    },
  });

  bot.on('polling_error', (err) => {
    const msg = String(err?.message || err || '');
    if (msg.includes('409') || msg.includes('Conflict') || msg.includes('terminated by other')) {
      if (!retryTimer) {
        console.log('[telegram] 409 conflict — retrying in 15s...');
        retryTimer = setTimeout(() => {
          retryTimer = null;
          console.log('[telegram] retrying polling after 409 conflict...');
          createBot();
        }, 15_000);
      }
      return;
    }
    if (!msg.includes('EFATAL') && !msg.includes('AggregateError')) {
      console.log(`[telegram] polling ${msg.slice(0, 120)}`);
    }
  });

  bot.on('error', (err) => {
    console.log(`[telegram] error ${err?.message?.slice(0, 120) || err}`);
  });

  botInstance = bot;

  // Re-attach all ready callbacks (commands, callbacks from other modules)
  for (const fn of readyCallbacks) {
    try { fn(bot); } catch (err) {
      console.log(`[telegram] callback error: ${err.message}`);
    }
  }

  return bot;
}

// Proxy pattern — always forward to the current bot instance
// This way all modules that import `bot` always use the active instance
const handler = {
  get(target, prop) {
    // If the prop exists on the proxy target itself (e.g. constructor, Symbol)
    if (prop in target) return target[prop];
    // Forward to the current bot instance
    const instance = botInstance;
    if (!instance) {
      console.log(`[telegram] accessed bot.${String(prop)} before bot created — creating now`);
      createBot();
      return botInstance[prop];
    }
    const val = instance[prop];
    // If it's a function, bind it to the instance so `this` works
    if (typeof val === 'function') {
      // Special handling for known methods to preserve return value types
      return val.bind(instance);
    }
    return val;
  },
  set(target, prop, value) {
    if (botInstance) {
      botInstance[prop] = value;
    }
    return true;
  },
};

// Create the first instance and start the proxy
createBot();

// Export a proxy that always delegates to the live bot instance
export const bot = new Proxy({}, handler);
