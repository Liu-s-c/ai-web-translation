// background.js - Service worker for AI Web Translator.
// Streaming DeepSeek V4 Flash API with incremental JSON pair extraction.
// Target: Simplified Chinese. Source: auto-detected.

const API_ENDPOINT = "https://api.deepseek.com/chat/completions";
const MODEL = "deepseek-v4-flash";
const TARGET_LANG = "简体中文";
const CACHE_PREFIX = "tr_";

const DEFAULT_SETTINGS = {
  apiKey: "",
  autoTranslate: false,
  glossary: [],
  skipCodeBlocks: true,
  showOriginalOnHover: true,
  whitelist: [],
};

// ---------- Settings ----------
function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get("settings", (res) => {
      resolve({ ...DEFAULT_SETTINGS, ...(res.settings || {}) });
    });
  });
}

function saveSettings(partial) {
  return new Promise((resolve) => {
    chrome.storage.local.get("settings", (res) => {
      const next = { ...DEFAULT_SETTINGS, ...(res.settings || {}), ...partial };
      chrome.storage.local.set({ settings: next }, () => resolve(next));
    });
  });
}

function broadcastSettings(settings) {
  chrome.runtime.sendMessage({ type: "SETTINGS_CHANGED", settings }).catch(() => {});
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (tab.id) {
        chrome.tabs.sendMessage(tab.id, { type: "SETTINGS_CHANGED", settings }).catch(() => {});
      }
    }
  });
}

// ---------- Message router (non-streaming messages) ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case "GET_SETTINGS":
          sendResponse({ ok: true, settings: await getSettings() });
          break;
        case "SAVE_SETTINGS": {
          const updated = await saveSettings(msg.settings || {});
          broadcastSettings(updated);
          sendResponse({ ok: true, settings: updated });
          break;
        }
        case "SETTINGS_CHANGED":
          broadcastSettings(msg.settings || {});
          sendResponse({ ok: true });
          break;
        case "TRANSLATE_ENABLED":
        case "TRANSLATE_DISABLED":
          chrome.tabs.query({}, (tabs) => {
            for (const tab of tabs) {
              if (tab.id) {
                chrome.tabs
                  .sendMessage(tab.id, {
                    type: msg.type === "TRANSLATE_ENABLED" ? "ENABLE_TRANSLATE" : "DISABLE_TRANSLATE",
                  })
                  .catch(() => {});
              }
            }
          });
          sendResponse({ ok: true });
          break;
        case "CLEAR_CACHE":
          await clearTranslationCache();
          sendResponse({ ok: true });
          break;
        case "GET_CACHE_STATS":
          sendResponse({ ok: true, stats: await getCacheStats() });
          break;
        default:
          sendResponse({ ok: false, error: "unknown-message" });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();
  return true;
});

chrome.runtime.onInstalled.addListener(async () => {
  const s = await getSettings();
  await saveSettings(s);
});

// ---------- Keepalive + streaming ports ----------
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "ait-keepalive") {
    const ping = setInterval(() => {
      try { port.postMessage({ type: "ping" }); } catch { clearInterval(ping); }
    }, 20000);
    port.onDisconnect.addListener(() => clearInterval(ping));
    return;
  }

  if (port.name === "ait-stream") {
    const MAX_CONCURRENT = 4;
    const ctx = {
      settings: null,
      glossaryHash: "",
      cacheToWrite: {},
      activePromises: new Set(),
      batchQueue: [],
      allDone: false,
      finalized: false,
      context: null,
      ready: false, // true after settings loaded and start batches launched
      pendingMsgs: [], // messages received before "start" completed
    };

    const finalize = () => {
      if (ctx.finalized) return;
      ctx.finalized = true;
      if (Object.keys(ctx.cacheToWrite).length) {
        chrome.storage.local.set(ctx.cacheToWrite).catch(() => {});
      }
      try { port.postMessage({ type: "all_done" }); } catch {}
    };

    const pumpQueue = () => {
      while (ctx.batchQueue.length > 0 && ctx.activePromises.size < MAX_CONCURRENT) {
        const batch = ctx.batchQueue.shift();
        // 预建 id→text 映射，避免 .then 中 batch.find 的 O(n²) 扫描
        const idToText = new Map();
        for (const it of batch) idToText.set(it.id, it.text);
        const p = streamTranslateBatch(ctx.settings, batch, ctx.context, (id, text) => {
          try { port.postMessage({ type: "translation", id, text }); } catch {}
        })
          .then((result) => {
            for (const [id, text] of Object.entries(result)) {
              const srcText = idToText.get(id);
              if (srcText !== undefined) ctx.cacheToWrite[cacheKey(srcText, ctx.glossaryHash)] = text;
            }
          })
          .catch((err) => {
            try {
              port.postMessage({
                type: "batch_error",
                error: err?.message || String(err),
                ids: batch.map((b) => b.id),
              });
            } catch {}
          })
          .finally(() => {
            ctx.activePromises.delete(p);
            pumpQueue();
            if (ctx.allDone && ctx.activePromises.size === 0 && ctx.batchQueue.length === 0) {
              finalize();
            }
          });
        ctx.activePromises.add(p);
      }
    };

    const launchBatch = (batch) => {
      ctx.batchQueue.push(batch);
      pumpQueue();
    };

    // Process a message now that settings are ready.
    const processMsg = (msg) => {
      if (msg.type === "add_batches") {
        for (const batch of msg.batches) launchBatch(batch);
      } else if (msg.type === "finish") {
        ctx.allDone = true;
        if (ctx.activePromises.size === 0 && ctx.batchQueue.length === 0) finalize();
      }
    };

    port.onMessage.addListener(async (msg) => {
      if (msg.type === "start") {
        try {
          ctx.settings = await getSettings();
          if (!ctx.settings.apiKey) {
            try { port.postMessage({ type: "error", error: "未设置 API Key" }); } catch {}
            return;
          }
          ctx.glossaryHash = hashGlossary(ctx.settings.glossary);
          ctx.context = msg.context;
          // Launch the start batches first (they're the viewport-priority ones)
          for (const batch of msg.batches) launchBatch(batch);
          ctx.ready = true;
          // Now process any messages that arrived while we were loading settings
          for (const pending of ctx.pendingMsgs) processMsg(pending);
          ctx.pendingMsgs = [];
        } catch (err) {
          try { port.postMessage({ type: "error", error: err?.message || String(err) }); } catch {}
        }
      } else if (msg.type === "add_batches" || msg.type === "finish") {
        if (!ctx.ready) {
          // Settings not loaded yet — buffer for later processing
          ctx.pendingMsgs.push(msg);
        } else {
          processMsg(msg);
        }
      }
    });
  }
});

// ---------- Incremental JSON pair extraction (position-tracking) ----------
// Extracts complete "id":"value" pairs from a partial JSON buffer.
// Tracks scan position to avoid re-scanning the entire buffer on each delta (O(n²) → O(n)).
// Backtracks ~200 chars from last position to catch pairs split across chunks.
function extractPairs(buffer, sentIds, scanState) {
  const pairs = {};
  const ss = scanState || { pos: 0 };
  const start = Math.max(0, ss.pos - 200);
  const regex = /"(\d+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  regex.lastIndex = start;
  let match;
  let lastEnd = start;
  while ((match = regex.exec(buffer)) !== null) {
    const id = match[1];
    if (!sentIds.has(id)) {
      try {
        const value = JSON.parse('"' + match[2] + '"');
        pairs[id] = value;
        sentIds.add(id);
      } catch {}
    }
    lastEnd = regex.lastIndex;
  }
  // Advance scan position to the end of the last complete pair.
  // Never decrease ss.pos — without this guard, a chunk with no complete
  // pairs would shift ss.pos backwards by 200 each call, eventually
  // reaching 0 and causing O(n²) full-buffer re-scans on every delta.
  ss.pos = Math.max(ss.pos, lastEnd);
  return pairs;
}

// ---------- Streaming DeepSeek API ----------
async function streamTranslateBatch(settings, items, context, onTranslation) {
  const inputObj = {};
  for (const m of items) inputObj[String(m.id)] = m.text;

  const glossaryLines = (settings.glossary || [])
    .filter((g) => g.from && g.to)
    .map((g) => `"${g.from}"→"${g.to}"`)
    .join(" ");

  const systemPrompt = buildSystemPrompt(glossaryLines);
  const userPrompt = buildUserPrompt(inputObj, context);

  const body = {
    model: MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    // 关闭思考模式（DeepSeek API 默认 enabled）— 思考模式会大幅增加 TTFT，
    // 且使 temperature/top_p 失效。翻译任务不需要思维链。
    thinking: { type: "disabled" },
    temperature: 0,
    top_p: 1,
    stream: true,
    stream_options: { include_usage: false },
    response_format: { type: "json_object" },
    max_tokens: 8192,
  };

  const resp = await fetch(API_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    let detail = "";
    try { detail = (await resp.json())?.error?.message || ""; } catch {}
    throw new Error(`API ${resp.status}: ${detail}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = "";
  let contentBuffer = "";
  const sentIds = new Set();
  const translations = {};
  const scanState = { pos: 0 };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    sseBuffer += decoder.decode(value, { stream: true });

    const lines = sseBuffer.split("\n");
    sseBuffer = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) continue;
      const data = trimmed.slice(6);
      if (data === "[DONE]") continue;
      try {
        const json = JSON.parse(data);
        const delta = json?.choices?.[0]?.delta?.content;
        if (delta) {
          contentBuffer += delta;
          const newPairs = extractPairs(contentBuffer, sentIds, scanState);
          for (const [id, text] of Object.entries(newPairs)) {
            translations[id] = text;
            onTranslation(id, text);
          }
        }
      } catch {}
    }
  }

  // Final extraction: scan entire buffer from start to catch any remaining pairs
  scanState.pos = 0;
  const finalPairs = extractPairs(contentBuffer, sentIds, scanState);
  for (const [id, text] of Object.entries(finalPairs)) {
    translations[id] = text;
    onTranslation(id, text);
  }

  // Fallback: if streaming extraction missed anything, try full JSON parse
  if (Object.keys(translations).length < items.length) {
    try {
      const parsed = JSON.parse(contentBuffer);
      for (const item of items) {
        if (!translations[item.id] && parsed[item.id]) {
          translations[item.id] = parsed[item.id];
          onTranslation(item.id, parsed[item.id]);
        }
      }
    } catch {}
  }

  return translations;
}

// ---------- Cache ----------
function hashGlossary(glossary) {
  if (!glossary || !glossary.length) return "0";
  let h = 0x811c9dc5;
  const s = glossary.map((g) => `${g.from}=>${g.to}`).join("\u0001");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function cacheKey(text, glossaryHash) {
  let h = 0x811c9dc5;
  const s = `${MODEL}\u0001${TARGET_LANG}\u0001${glossaryHash}\u0001${text}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return CACHE_PREFIX + (h >>> 0).toString(36);
}

async function clearTranslationCache() {
  const all = await chrome.storage.local.get(null);
  const keysToRemove = Object.keys(all).filter((k) => k.startsWith(CACHE_PREFIX));
  if (keysToRemove.length) await chrome.storage.local.remove(keysToRemove);
}

async function getCacheStats() {
  const all = await chrome.storage.local.get(null);
  let count = 0, bytes = 0;
  for (const k of Object.keys(all)) {
    if (k.startsWith(CACHE_PREFIX)) {
      count++;
      bytes += (k.length + JSON.stringify(all[k]).length) * 2;
    }
  }
  return { count, bytes };
}

// ---------- Prompts (ultra-compact for minimal TTFT) ----------
function buildSystemPrompt(glossaryLines) {
  const g = glossaryLines ? ` 术语:${glossaryLines}` : "";
  return `译为${TARGET_LANG},返JSON{序号:译文}。不译URL/邮箱/代码;品牌名保留;术语标准译;数字符号原样。${g}`;
}

function buildUserPrompt(inputObj, context) {
  const ctx = context || {};
  return `${ctx.title || ""}\n${JSON.stringify(inputObj)}`;
}
