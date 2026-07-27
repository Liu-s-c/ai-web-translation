// content.js - AI Web Translator content script.
// On load: if auto-translate is ON and page is English, translate automatically.
// Listens for ENABLE/DISABLE messages from the popup.

(() => {
  "use strict";

  // ---------- State ----------
  const state = {
    translating: false,
    translated: false,
    abortToken: 0, // Incremented to cancel any in-flight stream translation
    currentUrl: location.href, // Track URL for SPA navigation detection
    settings: null,
    originals: new WeakMap(), // textNode -> original string
    processedNodes: new WeakSet(),
    processedElements: new WeakSet(),
    observer: null,
    obsTimer: null,
    scrollRescanTimer: null,
    periodicTimer: null,
    keepalivePort: null,
    streamPort: null, // Current streaming port (for abort)
    progress: { total: 0, done: 0, failed: 0 },
    badgeEl: null,
    tooltipEl: null,
    autoStarted: false, // prevent duplicate auto-translate triggers
    applyingTranslation: false, // true while we're modifying nodeValue (to skip self-mutations)
  };

  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "IFRAME", "OBJECT", "EMBED",
    "TEXTAREA", "INPUT", "SELECT", "OPTION", "SVG", "MATH", "CANVAS",
    "TEMPLATE", "CODE", "KBD", "SAMP", "VAR", "TT",
  ]);

  const MIN_TEXT_LENGTH = 2;
  const BATCH_SIZE = 40;
  const MAX_CHARS_PER_BATCH = 5000;

  // ---------- Extension context validation ----------
  // 扩展上下文是否已失效（重载/更新后旧 content script 仍存活）
  // 失效后所有 chrome.runtime 调用都会抛 "Extension context invalidated"
  let contextInvalidated = false;
  function isContextValid() {
    if (contextInvalidated) return false;
    try {
      // 访问 chrome.runtime.id 在上下文失效时会抛错
      void chrome.runtime?.id;
      return true;
    } catch {
      contextInvalidated = true;
      return false;
    }
  }

  function safeRuntimeCall(fn, fallback) {
    if (!isContextValid()) return fallback;
    try {
      return fn();
    } catch (e) {
      if (String(e?.message || "").includes("invalidated")) {
        contextInvalidated = true;
      }
      return fallback;
    }
  }

  // 全局兜底：捕获任何漏网的 "Extension context invalidated" Promise 拒绝，
  // 防止 "Uncaught (in promise)" 错误污染控制台。
  window.addEventListener("unhandledrejection", (ev) => {
    const reason = ev?.reason;
    const msg = String(reason?.message || reason || "");
    if (msg.includes("invalidated") || msg.includes("Extension context")) {
      contextInvalidated = true;
      ev.preventDefault();
    }
  });
  // 同步错误兜底：捕获回调中抛出的 "Extension context invalidated"
  window.addEventListener("error", (ev) => {
    const msg = String(ev?.error?.message || ev?.message || "");
    if (msg.includes("invalidated") || msg.includes("Extension context")) {
      contextInvalidated = true;
      ev.preventDefault();
      return true;
    }
    return false;
  });

  // ---------- Settings ----------
  function getSettings() {
    return new Promise((resolve) => {
      if (!isContextValid()) {
        resolve({
          apiKey: "",
          autoTranslate: false,
          glossary: [],
          skipCodeBlocks: true,
          showOriginalOnHover: true,
          whitelist: [],
        });
        return;
      }
      try {
        chrome.storage.local.get("settings", (res) => {
          const defaults = {
            apiKey: "",
            autoTranslate: false,
            glossary: [],
            skipCodeBlocks: true,
            showOriginalOnHover: true,
          };
          resolve({ ...defaults, ...(res.settings || {}) });
        });
      } catch (e) {
        if (String(e?.message || "").includes("invalidated")) contextInvalidated = true;
        resolve({
          apiKey: "",
          autoTranslate: false,
          glossary: [],
          skipCodeBlocks: true,
          showOriginalOnHover: true,
          whitelist: [],
        });
      }
    });
  }

  // ---------- In-memory text cache (survives SPA navigations) ----------
  // Avoids chrome.storage.local.get round-trip for repeated text across pages.
  // Keyed by text content; value is the translation. Bounded to 2000 entries.
  const memCache = new Map();
  const MEM_CACHE_MAX = 2000;
  function memCacheGet(text) {
    if (memCache.has(text)) {
      const v = memCache.get(text);
      // Move to end (most-recently-used)
      memCache.delete(text);
      memCache.set(text, v);
      return v;
    }
    return undefined;
  }
  function memCacheSet(text, translation) {
    if (memCache.size >= MEM_CACHE_MAX) {
      // Evict oldest entry
      const firstKey = memCache.keys().next().value;
      memCache.delete(firstKey);
    }
    memCache.set(text, translation);
  }

  function send(msg) {
    return new Promise((resolve) => {
      if (!isContextValid()) {
        resolve({ ok: false, error: "context-invalidated" });
        return;
      }
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          if (chrome.runtime.lastError) {
            const errMsg = chrome.runtime.lastError.message;
            if (errMsg.includes("invalidated")) contextInvalidated = true;
            resolve({ ok: false, error: errMsg });
          } else {
            resolve(resp);
          }
        });
      } catch (e) {
        const msg = e?.message || String(e);
        if (msg.includes("invalidated")) contextInvalidated = true;
        resolve({ ok: false, error: msg });
      }
    });
  }

  // ---------- Keepalive port (keeps MV3 SW alive during translation) ----------
  function openKeepalive() {
    if (state.keepalivePort) return;
    if (!isContextValid()) return;
    try {
      state.keepalivePort = chrome.runtime.connect({ name: "ait-keepalive" });
      state.keepalivePort.onMessage.addListener(() => {}); // consume pings
      state.keepalivePort.onDisconnect.addListener(() => {
        state.keepalivePort = null;
      });
    } catch (e) {
      if (String(e?.message || "").includes("invalidated")) contextInvalidated = true;
      state.keepalivePort = null;
    }
  }
  function closeKeepalive() {
    if (state.keepalivePort) {
      try {
        state.keepalivePort.disconnect();
      } catch {}
      state.keepalivePort = null;
    }
  }

  // ---------- Abort in-flight stream translation ----------
  // Cancels any ongoing translation by disconnecting the stream port and
  // incrementing the abort token (checked by async loops).
  function cancelInFlight() {
    state.abortToken++;
    state.translating = false;
    if (state.streamPort) {
      try { state.streamPort.disconnect(); } catch {}
      state.streamPort = null;
    }
  }

  // ---------- SPA navigation detection ----------
  // Detects URL changes (pushState/replaceState/popstate) and triggers
  // a fresh translation on the new page, cancelling any in-flight work.
  // IMPORTANT: We do NOT clear processedNodes/originals on navigation.
  // Same-site pages share repeated UI text (nav, tabs, buttons) — keeping
  // the WeakSet means those already-translated nodes are skipped instantly,
  // and the cache (chrome.storage) supplies translations for any new
  // occurrences of previously-seen text.
  let lastUrl = location.href;
  function checkNavigation() {
    const url = location.href;
    if (url === lastUrl) return false;
    lastUrl = url;
    state.currentUrl = url;
    // Cancel any in-flight translation from the previous page.
    cancelInFlight();
    // Reset translation state, but KEEP processedNodes/originals so that
    // unchanged DOM nodes (e.g. persistent nav bar) are not re-translated.
    state.translated = false;
    state.translating = false;
    stopObserver();
    hideTooltip();
    removeBadge();
    // Re-translate new page if auto-translate is on and it's English.
    state.autoStarted = false;
    maybeAutoTranslate();
    return true;
  }

  // Hook history APIs for SPA navigation detection.
  const hookHistory = (method) => {
    const orig = history[method];
    history[method] = function (...args) {
      const r = orig.apply(this, args);
      setTimeout(checkNavigation, 50);
      return r;
    };
  };
  hookHistory("pushState");
  hookHistory("replaceState");
  window.addEventListener("popstate", () => setTimeout(checkNavigation, 50));

  function broadcastState() {
    if (!isContextValid()) return;
    safeRuntimeCall(
      () =>
        chrome.runtime
          .sendMessage({
            type: "STATE_UPDATE",
            translated: state.translated,
            translating: state.translating,
          })
          .catch(() => {}),
      undefined
    );
  }

  // ---------- English page detection ----------
  function samplePageText(maxChars = 2400) {
    // Collect visible text quickly without full TreeWalker overhead.
    const chunks = [];
    let total = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName;
        if (SKIP_TAGS.has(tag)) return NodeFilter.FILTER_REJECT;
        if (tag === "PRE") return NodeFilter.FILTER_REJECT;
        if (parent.isContentEditable) return NodeFilter.FILTER_REJECT;
        const cs = getComputedStyle(parent);
        if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") {
          return NodeFilter.FILTER_REJECT;
        }
        const t = node.nodeValue;
        if (!t || t.trim().length < 2) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode()) && total < maxChars) {
      const t = n.nodeValue.trim();
      if (t) {
        chunks.push(t);
        total += t.length;
      }
    }
    return chunks.join(" ");
  }

  function isEnglishPage() {
    // 1) html lang attribute
    const htmlLang = (document.documentElement.lang || "").toLowerCase();
    if (htmlLang.startsWith("en")) return true;
    if (htmlLang.startsWith("zh") || htmlLang.startsWith("ja") || htmlLang.startsWith("ko")) {
      return false;
    }

    // 2) Text ratio analysis
    const sample = samplePageText(2400);
    if (!sample || sample.length < 30) return false;

    let latin = 0;
    let cjk = 0;
    let cyrillic = 0;
    let arabic = 0;
    for (let i = 0; i < sample.length; i++) {
      const code = sample.charCodeAt(i);
      if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) latin++;
      else if (code >= 0x4e00 && code <= 0x9fff) cjk++;
      else if (code >= 0x3040 && code <= 0x30ff) cjk++; // Japanese kana
      else if (code >= 0xac00 && code <= 0xd7af) cjk++; // Korean
      else if (code >= 0x0400 && code <= 0x04ff) cyrillic++;
      else if (code >= 0x0600 && code <= 0x06ff) arabic++;
    }

    const totalLetters = latin + cjk + cyrillic + arabic;
    if (totalLetters < 20) return false;

    // English if Latin dominates (>70%) and CJK is small.
    if (latin / totalLetters > 0.7 && cjk / totalLetters < 0.15) return true;
    return false;
  }

  // ---------- DOM walking ----------
  // Classes/attributes that mark text for screen readers only (visually hidden).
  const A11Y_HIDDEN_MARKERS = new Set([
    "sr-only", "sr-only-focusable", "visually-hidden", "visuallyhidden",
    "a11y-sr-only", "screen-reader-text", "screen-reader", "reader-only",
    "u-visually-hidden", "hide-visually", "element-invisible",
  ]);

  function shouldSkipElement(el, settings) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return true;
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (settings.skipCodeBlocks && el.tagName === "PRE") return true;
    if (el.getAttribute("translate") === "no") return true;
    if (el.isContentEditable) return true;
    if (el.classList?.contains("ait-translated")) return true;
    // Skip screen-reader-only / accessibility-only text.
    if (el.getAttribute("aria-hidden") === "true") return true;
    if (el.getAttribute("role") === "presentation") return true;
    if (el.getAttribute("role") === "none") return true;
    for (const c of el.classList) {
      if (A11Y_HIDDEN_MARKERS.has(c)) return true;
    }
    // 不在此处调用 checkVisibility / getComputedStyle — 对 1000+ 节点太慢。
    // 可见性检查移到 sortByViewport 中只对视口内元素做。
    return false;
  }

  function isTranslatableText(text) {
    if (!text) return false;
    const trimmed = text.trim();
    if (trimmed.length < MIN_TEXT_LENGTH) return false;
    return /[\p{L}\p{N}]/u.test(trimmed);
  }

  // 递归检查元素子树中是否有未处理的文本节点（用于 MutationObserver
  // 快速判断新增内容是否需要翻译，避免对已翻译子树做无谓的重新扫描）。
  function hasUnprocessedText(root) {
    // 限深度/数量避免在巨大子树上耗时
    let count = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (state.processedNodes.has(node)) return NodeFilter.FILTER_REJECT;
        if (!isTranslatableText(node.nodeValue)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode()) && count < 50) count++;
    return count > 0;
  }

  function collectTextNodes(root, settings, out = []) {
    let walker;
    try {
      walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          if (shouldSkipElement(parent, settings)) return NodeFilter.FILTER_REJECT;
          if (state.processedNodes.has(node)) return NodeFilter.FILTER_REJECT;
          if (!isTranslatableText(node.nodeValue)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
    } catch {
      return out;
    }
    let n;
    while ((n = walker.nextNode())) {
      out.push({ node: n, text: n.nodeValue });
    }
    // Shadow DOM
    const elements = root.querySelectorAll ? root.querySelectorAll("*") : [];
    for (const el of elements) {
      if (el.shadowRoot) collectTextNodes(el.shadowRoot, settings, out);
    }
    return out;
  }

  function buildBatches(items) {
    const batches = [];
    let cur = [];
    let curChars = 0;
    for (const it of items) {
      const len = it.text.length;
      if (cur.length >= BATCH_SIZE || (cur.length && curChars + len > MAX_CHARS_PER_BATCH)) {
        batches.push(cur);
        cur = [];
        curChars = 0;
      }
      cur.push(it);
      curChars += len;
    }
    if (cur.length) batches.push(cur);
    return batches;
  }

  // ---------- Text deduplication ----------
  // Many pages repeat UI text (buttons, labels). Deduplicate to reduce API calls.
  function deduplicate(items) {
    const seen = new Map(); // text -> { id, text, nodes: [] }
    const result = [];
    let id = 0;
    for (const item of items) {
      const existing = seen.get(item.text);
      if (existing) {
        existing.nodes.push(item.node);
      } else {
        const entry = { id: String(id++), text: item.text, nodes: [item.node] };
        seen.set(item.text, entry);
        result.push(entry);
      }
    }
    return result;
  }

  // ---------- Viewport priority (strict, fast) ----------
  // 视口判定逻辑（针对信息流/滚动长文本优化）：
  // - P0 当前视口内（rect.top < vh && rect.bottom > 0）— 用户正在看
  // - P1 视口下方缓冲区（vh <= rect.top < vh*2.5）— 即将滚到
  // - P2 视口上方缓冲区（-vh*1.5 < rect.bottom <= 0）— 刚滚过可能回滚
  // - P3 视口下方远区（rect.top >= vh*2.5）
  // - P4 视口上方远区（rect.bottom <= -vh*1.5）
  // - P5 不可见（display:none / checkVisibility 失败）
  // 不调用 getComputedStyle（太慢），只用 getBoundingClientRect + 对视口
  // 内元素调 checkVisibility（数量少）。
  function sortByViewport(items) {
    const vh = window.innerHeight;
    const p0 = []; // 当前视口
    const p1 = []; // 视口下方缓冲
    const p2 = []; // 视口上方缓冲
    const p3 = []; // 视口下方远区
    const p4 = []; // 视口上方远区
    const p5 = []; // 不可见
    for (const item of items) {
      const parent = item.node.parentElement;
      if (!parent) { p0.push(item); continue; }
      let rect;
      try {
        rect = parent.getBoundingClientRect();
      } catch {
        p5.push(item);
        continue;
      }
      const top = rect.top;
      const bottom = rect.bottom;
      // 几何视口分类
      // 过滤：未渲染元素（offsetWidth/Height=0）— 占位但无内容，不应优先翻译
      const hasSize = parent.offsetWidth > 0 || parent.offsetHeight > 0;
      if (top < vh && bottom > 0 && hasSize) {
        // 几何上在视口内 → 做 checkVisibility 过滤隐藏元素
        if (typeof parent.checkVisibility === "function" && !parent.checkVisibility()) {
          p5.push(item);
        } else if (parent.offsetParent === null) {
          p5.push(item);
        } else {
          p0.push(item);
        }
      } else if (top >= vh && top < vh * 2.5) {
        p1.push(item);
      } else if (bottom <= 0 && bottom > -vh * 1.5) {
        p2.push(item);
      } else if (top >= vh * 2.5) {
        p3.push(item);
      } else {
        p4.push(item);
      }
    }
    // P0 按垂直位置排序（视口顶部优先）
    p0.sort((a, b) => {
      const ra = a.node.parentElement?.getBoundingClientRect?.();
      const rb = b.node.parentElement?.getBoundingClientRect?.();
      return (ra?.top ?? 0) - (rb?.top ?? 0);
    });
    // P1 按垂直位置排序（离视口近的优先）
    p1.sort((a, b) => {
      const ra = a.node.parentElement?.getBoundingClientRect?.();
      const rb = b.node.parentElement?.getBoundingClientRect?.();
      return (ra?.top ?? 0) - (rb?.top ?? 0);
    });
    // 优先级：当前视口 → 下方缓冲 → 上方缓冲 → 下方远区 → 上方远区 → 不可见
    return [...p0, ...p1, ...p2, ...p3, ...p4, ...p5];
  }

  // ---------- Replacement ----------
  // applyingTranslation 标志位：翻译修改 nodeValue 时置 true，
  // MutationObserver 据此跳过翻译自身的修改，避免自我触发循环。
  // 网页自身修改文本（JS 动态更新、AJAX 局部刷新等）时该标志为 false，
  // 会正常触发重新翻译。
  function applyTranslation(node, translation) {
    if (!node || !translation) return;
    const original = node.nodeValue;
    if (original === translation) {
      state.processedNodes.add(node);
      return;
    }
    state.originals.set(node, original);
    state.processedNodes.add(node);
    if (node.parentElement) state.processedElements.add(node.parentElement);
    state.applyingTranslation = true;
    try {
      node.nodeValue = translation;
    } finally {
      // 微任务结束后清除（MutationObserver 在微任务后回调）
      Promise.resolve().then(() => { state.applyingTranslation = false; });
    }
    const parent = node.parentElement;
    if (parent && !parent.classList.contains("ait-translated")) {
      parent.classList.add("ait-translated");
      parent.addEventListener("mouseenter", onHover, { passive: true });
      parent.addEventListener("mouseleave", onLeave, { passive: true });
      parent.addEventListener("mousemove", onMove, { passive: true });
    }
  }

  function onHover(e) {
    if (!state.settings?.showOriginalOnHover) return;
    const original = findOriginalIn(e.currentTarget);
    if (original) showTooltip(original, e.clientX, e.clientY);
  }
  function onMove(e) {
    if (state.tooltipEl?.classList.contains("ait-tooltip-visible")) {
      const w = state.tooltipEl.offsetWidth || 240;
      const h = state.tooltipEl.offsetHeight || 40;
      let left = e.clientX + 14;
      let top = e.clientY + 18;
      if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - w - 8);
      if (top + h > window.innerHeight - 8) top = Math.max(8, e.clientY - h - 14);
      state.tooltipEl.style.left = left + "px";
      state.tooltipEl.style.top = top + "px";
    }
  }
  function onLeave() {
    hideTooltip();
  }
  function findOriginalIn(el) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n;
    const parts = [];
    while ((n = walker.nextNode())) {
      const orig = state.originals.get(n);
      if (orig !== undefined) parts.push(orig);
    }
    return parts.length ? parts.join("") : null;
  }

  // ---------- Tooltip ----------
  function ensureTooltip() {
    if (state.tooltipEl && document.body.contains(state.tooltipEl)) return;
    const el = document.createElement("div");
    el.className = "ait-tooltip";
    el.setAttribute("role", "tooltip");
    document.documentElement.appendChild(el);
    state.tooltipEl = el;
  }
  function showTooltip(text, x, y) {
    ensureTooltip();
    state.tooltipEl.textContent = text;
    state.tooltipEl.classList.add("ait-tooltip-visible");
    const w = state.tooltipEl.offsetWidth || 240;
    const h = state.tooltipEl.offsetHeight || 40;
    let left = x + 14;
    let top = y + 18;
    if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - w - 8);
    if (top + h > window.innerHeight - 8) top = Math.max(8, y - h - 14);
    state.tooltipEl.style.left = left + "px";
    state.tooltipEl.style.top = top + "px";
  }
  function hideTooltip() {
    if (state.tooltipEl) state.tooltipEl.classList.remove("ait-tooltip-visible");
  }

  // ---------- Circular progress badge (iOS-style, single instance) ----------
  const RING_R = 16;
  const RING_CIRC = 2 * Math.PI * RING_R; // circumference
  let badgeRemoveTimer = null;

  function ensureBadge() {
    if (state.badgeEl && document.documentElement.contains(state.badgeEl)) return;
    const el = document.createElement("div");
    el.className = "ait-badge";
    el.setAttribute("aria-live", "polite");
    el.innerHTML = `
      <svg class="ait-badge-ring" viewBox="0 0 40 40">
        <circle class="ait-badge-track" cx="20" cy="20" r="${RING_R}" />
        <circle class="ait-badge-progress" cx="20" cy="20" r="${RING_R}" />
      </svg>
      <div class="ait-badge-icon"></div>
    `;
    document.documentElement.appendChild(el);
    state.badgeEl = el;
    // Initialize progress ring fully empty.
    const prog = el.querySelector(".ait-badge-progress");
    prog.style.strokeDasharray = RING_CIRC;
    prog.style.strokeDashoffset = RING_CIRC;
  }

  function removeBadge() {
    if (badgeRemoveTimer) {
      clearTimeout(badgeRemoveTimer);
      badgeRemoveTimer = null;
    }
    if (state.badgeEl) {
      const el = state.badgeEl;
      el.classList.add("ait-badge-hiding");
      setTimeout(() => el.remove(), 300);
      state.badgeEl = null;
    }
  }

  // kind: "working" | "done" | "error"
  // progress: 0..1 (only meaningful for "working")
  function updateBadge(kind, progress) {
    ensureBadge();
    const el = state.badgeEl;
    if (badgeRemoveTimer) {
      clearTimeout(badgeRemoveTimer);
      badgeRemoveTimer = null;
    }
    el.classList.remove("ait-badge-hiding");

    const prog = el.querySelector(".ait-badge-progress");
    const iconWrap = el.querySelector(".ait-badge-icon");

    if (kind === "working") {
      el.className = "ait-badge ait-badge-working";
      const p = Math.max(0, Math.min(1, progress || 0));
      prog.style.strokeDashoffset = RING_CIRC * (1 - p);
      // Translate icon
      iconWrap.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
             stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 5h7M9 3v2c0 4.418-2.239 8-5 8" />
          <path d="M5 9c0 2.144 2.953 3.908 6.7 4" />
          <path d="M12 20l4-9 4 9M14.5 16h3" />
        </svg>`;
    } else if (kind === "done") {
      el.className = "ait-badge ait-badge-done";
      prog.style.strokeDashoffset = 0;
      // Checkmark icon
      iconWrap.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"
             stroke-linecap="round" stroke-linejoin="round">
          <polyline points="5 13 10 18 19 7" />
        </svg>`;
    } else if (kind === "error") {
      el.className = "ait-badge ait-badge-error";
      prog.style.strokeDashoffset = 0;
      iconWrap.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"
             stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="7" x2="12" y2="13" />
          <circle cx="12" cy="17" r="0.5" fill="currentColor" />
        </svg>`;
    }
  }

  // ---------- Apply translation to a deduplicated group ----------
  function applyToGroup(item, translation) {
    for (const node of item.nodes) {
      applyTranslation(node, translation);
    }
  }

  // ---------- 流式翻译（单次收集 + 视口优先排序 + 批次顺序发送） ----------
  // 关键设计：
  // 1. 单次 collectTextNodes 收集所有文本节点（shouldSkipElement 用
  //    checkVisibility 而非 getComputedStyle，1000 节点 ~50ms）
  // 2. sortByViewport 排序：视口内（top→bottom）→ 下方 → 上方 → 不可见
  // 3. deduplicate 只调用一次，确保 id 全局唯一（之前的 bug 是两次
  //    deduplicate 产生重复 id，导致翻译应用到错误节点）
  // 4. 批次按排序顺序发送，视口批次排在队列最前面，background 的
  //    FIFO 队列 + MAX_CONCURRENT=4 确保视口批次先被 API 处理
  function streamTranslateProgressive(context) {
    return new Promise((resolve) => {
      const myToken = state.abortToken;

      // ===== 单次收集 + 排序 + 去重 =====
      const rawItems = collectTextNodes(document.body, state.settings);
      if (!rawItems.length) {
        resolve({ failed: 0, aborted: false, translatedCount: 0 });
        return;
      }
      const sorted = sortByViewport(rawItems);
      const deduped = deduplicate(sorted); // 只调用一次，id 全局唯一
      state.progress.total = rawItems.length;

      // ===== 应用 memCache，构建 id→item 映射，拆分未缓存项 =====
      const idToItem = new Map();
      const applied = new Set();
      const uncachedItems = [];
      for (const it of deduped) {
        idToItem.set(it.id, it);
        const cached = memCacheGet(it.text);
        if (cached !== undefined) {
          applied.add(it.id);
          applyToGroup(it, cached);
          state.progress.done += it.nodes.length;
        } else {
          uncachedItems.push(it);
        }
      }

      // 更新进度条（缓存命中的部分）
      if (state.progress.total) {
        updateBadge("working", Math.min(1, state.progress.done / state.progress.total));
      }

      // 如果全部缓存命中，直接完成
      if (!uncachedItems.length) {
        resolve({ failed: 0, aborted: false, translatedCount: applied.size });
        return;
      }

      // ===== 构建批次（按视口优先顺序）=====
      const batches = buildBatches(
        uncachedItems.map((it) => ({ id: it.id, text: it.text }))
      );

      // ===== 连接 background =====
      let port;
      try {
        if (!isContextValid()) throw new Error("context-invalidated");
        port = chrome.runtime.connect({ name: "ait-stream" });
        state.streamPort = port;
      } catch (e) {
        if (String(e?.message || "").includes("invalidated")) contextInvalidated = true;
        resolve({ failed: uncachedItems.length, aborted: false, translatedCount: 0 });
        return;
      }

      let resolved = false;
      const isCancelled = () => state.abortToken !== myToken;

      const finish = (aborted) => {
        if (resolved) return;
        resolved = true;
        if (state.streamPort === port) state.streamPort = null;
        try { port.disconnect(); } catch {}
        resolve({ failed: 0, aborted, translatedCount: applied.size });
      };

      port.onMessage.addListener((msg) => {
        if (isCancelled()) { finish(true); return; }
        if (msg.type === "translation") {
          const item = idToItem.get(msg.id);
          if (item && !applied.has(msg.id)) {
            applied.add(msg.id);
            applyToGroup(item, msg.text);
            memCacheSet(item.text, msg.text);
            state.progress.done += item.nodes.length;
            if (state.progress.total) {
              updateBadge("working", Math.min(1, state.progress.done / state.progress.total));
            }
          }
        } else if (msg.type === "batch_error") {
          if (msg.ids) {
            for (const id of msg.ids) {
              if (!applied.has(id)) {
                const item = idToItem.get(id);
                if (item) {
                  state.progress.failed += item.nodes.length;
                  state.progress.done += item.nodes.length;
                  if (state.progress.total) {
                    updateBadge("working", Math.min(1, state.progress.done / state.progress.total));
                  }
                }
              }
            }
          }
        } else if (msg.type === "all_done" || msg.type === "error") {
          finish(false);
        }
      });

      port.onDisconnect.addListener(() => finish(isCancelled()));

      // ===== 发送所有批次：第一个用 "start"，其余用 "add_batches"，最后 "finish" =====
      // 批次顺序就是 sortByViewport 的顺序：视口批次在前。
      // background 的 FIFO 队列确保视口批次先被处理。
      try {
        port.postMessage({ type: "start", batches: [batches[0]], context });
        if (batches.length > 1) {
          port.postMessage({ type: "add_batches", batches: batches.slice(1) });
        }
        port.postMessage({ type: "finish" });
      } catch {
        finish(false);
        return;
      }

      // 总超时：30 秒后强制结束
      setTimeout(() => {
        if (!resolved) finish(false);
      }, 30000);
    });
  }

  // ---------- 仅翻译视口内未处理节点（滚动即时响应） ----------
  // 专为信息流/滚动长文本设计：滚动时立即调用，只收集当前视口+缓冲区
  // 内的未处理节点，不做全量 collectTextNodes（避免大页面 50ms+ 延迟）。
  // 完成后再异步触发一次全量补全。
  function streamTranslateViewportOnly(context) {
    return new Promise((resolve) => {
      const myToken = state.abortToken;
      const vh = window.innerHeight;

      // ===== 只收集视口+缓冲区内的未处理节点 =====
      const rawItems = [];
      let walker;
      try {
        walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
          acceptNode(node) {
            const parent = node.parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;
            if (shouldSkipElement(parent, state.settings)) return NodeFilter.FILTER_REJECT;
            if (state.processedNodes.has(node)) return NodeFilter.FILTER_REJECT;
            if (!isTranslatableText(node.nodeValue)) return NodeFilter.FILTER_REJECT;
            // 视口 + 上下缓冲区（vh*1.5）
            let rect;
            try {
              rect = parent.getBoundingClientRect();
            } catch {
              return NodeFilter.FILTER_REJECT;
            }
            // 当前视口 + 上方 1 屏 + 下方 2 屏（用户向上/向下滚动都覆盖到）
            if (rect.bottom > -vh && rect.top < vh * 3) {
              return NodeFilter.FILTER_ACCEPT;
            }
            return NodeFilter.FILTER_REJECT;
          },
        });
      } catch {
        resolve({ failed: 0, aborted: false, translatedCount: 0 });
        return;
      }
      let n;
      while ((n = walker.nextNode())) {
        rawItems.push({ node: n, text: n.nodeValue });
      }
      if (!rawItems.length) {
        resolve({ failed: 0, aborted: false, translatedCount: 0 });
        return;
      }

      const sorted = sortByViewport(rawItems);
      const deduped = deduplicate(sorted);
      state.progress.total = rawItems.length;

      const idToItem = new Map();
      const applied = new Set();
      const uncachedItems = [];
      for (const it of deduped) {
        idToItem.set(it.id, it);
        const cached = memCacheGet(it.text);
        if (cached !== undefined) {
          applied.add(it.id);
          applyToGroup(it, cached);
          state.progress.done += it.nodes.length;
        } else {
          uncachedItems.push(it);
        }
      }
      if (state.progress.total) {
        updateBadge("working", Math.min(1, state.progress.done / state.progress.total));
      }
      if (!uncachedItems.length) {
        resolve({ failed: 0, aborted: false, translatedCount: applied.size });
        return;
      }

      const batches = buildBatches(
        uncachedItems.map((it) => ({ id: it.id, text: it.text }))
      );

      let port;
      try {
        if (!isContextValid()) throw new Error("context-invalidated");
        port = chrome.runtime.connect({ name: "ait-stream" });
        state.streamPort = port;
      } catch (e) {
        if (String(e?.message || "").includes("invalidated")) contextInvalidated = true;
        resolve({ failed: uncachedItems.length, aborted: false, translatedCount: 0 });
        return;
      }

      let resolved = false;
      const isCancelled = () => state.abortToken !== myToken;
      const finish = (aborted) => {
        if (resolved) return;
        resolved = true;
        if (state.streamPort === port) state.streamPort = null;
        try { port.disconnect(); } catch {}
        resolve({ failed: 0, aborted, translatedCount: applied.size });
      };

      port.onMessage.addListener((msg) => {
        if (isCancelled()) { finish(true); return; }
        if (msg.type === "translation") {
          const item = idToItem.get(msg.id);
          if (item && !applied.has(msg.id)) {
            applied.add(msg.id);
            applyToGroup(item, msg.text);
            memCacheSet(item.text, msg.text);
            state.progress.done += item.nodes.length;
            if (state.progress.total) {
              updateBadge("working", Math.min(1, state.progress.done / state.progress.total));
            }
          }
        } else if (msg.type === "batch_error") {
          if (msg.ids) {
            for (const id of msg.ids) {
              if (!applied.has(id)) {
                const item = idToItem.get(id);
                if (item) {
                  state.progress.failed += item.nodes.length;
                  state.progress.done += item.nodes.length;
                  if (state.progress.total) {
                    updateBadge("working", Math.min(1, state.progress.done / state.progress.total));
                  }
                }
              }
            }
          }
        } else if (msg.type === "all_done" || msg.type === "error") {
          finish(false);
        }
      });
      port.onDisconnect.addListener(() => finish(isCancelled()));

      try {
        port.postMessage({ type: "start", batches: [batches[0]], context });
        if (batches.length > 1) {
          port.postMessage({ type: "add_batches", batches: batches.slice(1) });
        }
        port.postMessage({ type: "finish" });
      } catch {
        finish(false);
        return;
      }

      setTimeout(() => {
        if (!resolved) finish(false);
      }, 30000);
    });
  }

  // ---------- Translation orchestration ----------
  async function translatePage() {
    if (state.translating) return;
    if (state.translated) {
      restorePage();
      return;
    }
    if (!state.settings) state.settings = await getSettings();
    if (!state.settings.apiKey) {
      updateBadge("error");
      setTimeout(removeBadge, 3000);
      return;
    }

    const myToken = state.abortToken;
    state.translating = true;
    state.progress = { total: 0, done: 0, failed: 0 };
    openKeepalive();
    broadcastState();
    updateBadge("working", 0);

    // 单次收集 + 视口优先排序 + 批次顺序发送。
    // shouldSkipElement 不调 getComputedStyle/checkVisibility（快），
    // sortByViewport 只对视口内元素调 checkVisibility（数量少）。
    const context = { url: location.href, title: document.title };
    const result = await streamTranslateProgressive(context);

    if (result.aborted || state.abortToken !== myToken) {
      closeKeepalive();
      return;
    }

    state.translating = false;
    state.translated = true;
    closeKeepalive();
    updateBadge("done");
    broadcastState();
    setTimeout(removeBadge, 2500);
    startObserver();
  }

  // ---------- Restore ----------
  function restorePage() {
    const marked = document.querySelectorAll(".ait-translated");
    for (const el of marked) {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        const orig = state.originals.get(n);
        if (orig !== undefined) {
          n.nodeValue = orig;
          state.originals.delete(n);
          state.processedNodes.delete(n);
        }
      }
      el.classList.remove("ait-translated");
      el.removeEventListener("mouseenter", onHover);
      el.removeEventListener("mouseleave", onLeave);
      el.removeEventListener("mousemove", onMove);
    }
    state.processedElements = new WeakSet();
    state.translated = false;
    state.translating = false;
    cancelInFlight();
    stopObserver();
    closeKeepalive();
    hideTooltip();
    removeBadge();
    broadcastState();
  }

  // ---------- Aggressive real-time re-scan ----------
  // 监听 DOM 变化（网页自身动态更新、AJAX 局部刷新、JS 修改文本等），
  // 一旦检测到未翻译内容立即触发重新翻译。
  // 用 applyingTranslation 标志位过滤翻译自身的修改，避免自我触发循环。
  function startObserver() {
    stopObserver();
    state.observer = new MutationObserver((mutations) => {
      if (!state.translated) return;
      // 翻译自身正在修改 nodeValue — 跳过这批 mutation
      if (state.applyingTranslation) return;
      let hasNewContent = false;
      for (const m of mutations) {
        if (m.type === "childList" && m.addedNodes.length > 0) {
          for (const node of m.addedNodes) {
            if (node.nodeType === Node.TEXT_NODE) {
              if (isTranslatableText(node.nodeValue) && !state.processedNodes.has(node)) {
                hasNewContent = true;
                break;
              }
            } else if (node.nodeType === Node.ELEMENT_NODE) {
              // 递归检查新增元素子树中是否有未处理的文本节点
              if (hasUnprocessedText(node)) {
                hasNewContent = true;
                break;
              }
            }
          }
          if (hasNewContent) break;
        }
        // characterData：网页自身修改已翻译节点的文本（如倒计时、动态更新）
        // 此时节点已 processed，但内容变了需要重新翻译。
        // 翻译自身的修改已被 applyingTranslation 标志过滤。
        if (m.type === "characterData" && m.target) {
          const node = m.target;
          if (node.nodeType === Node.TEXT_NODE && isTranslatableText(node.nodeValue)) {
            // 网页自身修改了文本 — 清除 processed 标记，让 collectTextNodes 重新收集
            // 同时清除 originals 映射，避免 restore 时用旧原文覆盖新内容
            if (state.processedNodes.has(node)) {
              state.processedNodes.delete(node);
              state.originals.delete(node);
            }
            hasNewContent = true;
            break;
          }
        }
      }
      if (hasNewContent) scheduleRescan("mutation");
    });
    state.observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    // User interaction listeners — catch lazy-loaded / SPA-rendered content
    // that mutations might miss or batch too late.
    const interactionEvents = ["click", "mouseup", "keyup", "focusin", "change"];
    for (const evt of interactionEvents) {
      document.addEventListener(
        evt,
        () => {
          if (state.translated) scheduleRescan("interaction");
        },
        { passive: true, capture: true }
      );
    }
    // Scroll: viewport reprioritization — translate newly visible content first.
    window.addEventListener("scroll", onScrollRescan, { passive: true, capture: true });
    // Resize / hashchange (SPA route changes sometimes).
    window.addEventListener("resize", () => state.translated && scheduleRescan("resize"), {
      passive: true,
    });
    window.addEventListener("hashchange", () => state.translated && scheduleRescan("hash"), {
      passive: true,
    });

    // Safety-net periodic scan: every 2.5s while translated, in case
    // something was missed (e.g. animations completing without events).
    state.periodicTimer = setInterval(() => {
      if (!isContextValid()) { stopObserver(); return; }
      if (state.translated && !state.translating) scheduleRescan("periodic", true);
    }, 2500);
  }

  function stopObserver() {
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
    if (state.obsTimer) {
      clearTimeout(state.obsTimer);
      state.obsTimer = null;
    }
    if (state.scrollRescanTimer) {
      clearTimeout(state.scrollRescanTimer);
      state.scrollRescanTimer = null;
    }
    if (state.periodicTimer) {
      clearInterval(state.periodicTimer);
      state.periodicTimer = null;
    }
  }

  // Debounced full-document re-scan for untranslated text nodes.
  // fast=true uses a shorter delay (for periodic safety-net and scroll).
  function scheduleRescan(reason, fast) {
    if (state.obsTimer) clearTimeout(state.obsTimer);
    const delay = fast ? 80 : 150;
    state.obsTimer = setTimeout(async () => {
      state.obsTimer = null;
      if (!isContextValid()) return;
      if (!state.translated || state.translating) return;
      await rescanAndTranslate();
    }, delay);
  }

  // Scan the entire document for untranslated text nodes and translate them.
  // Skips nodes already in state.processedNodes.
  // 如果没有未处理节点（translatedCount === 0），不显示 badge，避免
  // 翻译完成后 mutation 反复触发空转的进度条。
  async function rescanAndTranslate() {
    if (!state.settings) state.settings = await getSettings();
    const myToken = state.abortToken;
    state.progress = { total: 0, done: 0, failed: 0 };
    state.translating = true;
    openKeepalive();
    broadcastState();
    // 不立即显示 working badge — 先看是否有内容要翻译
    const context = { url: location.href, title: document.title };
    const result = await streamTranslateProgressive(context);
    if (result.aborted || state.abortToken !== myToken) {
      closeKeepalive();
      return;
    }
    state.translating = false;
    closeKeepalive();
    broadcastState();
    // 只有实际翻译了内容才显示 done badge
    if (result.translatedCount > 0) {
      updateBadge("done");
      setTimeout(removeBadge, 2500);
    }
  }

  // ---------- Scroll-triggered viewport translation（信息流/长文本专用） ----------
  // 滚动时立即用 streamTranslateViewportOnly 翻译视口内未处理节点，
  // 不等全量 collectTextNodes（避免大页面 50ms+ 延迟）。
  // 用 rAF + 短节流，滚动停止后 ~80ms 内触发。
  let scrollRafPending = false;
  let lastScrollTime = 0;
  function onScrollRescan() {
    if (!state.translated) return;
    lastScrollTime = Date.now();
    // 正在翻译时不打断（避免频繁取消重发），但记录滚动以便翻译完成后补全
    if (state.translating) return;
    if (scrollRafPending) return;
    scrollRafPending = true;
    requestAnimationFrame(() => {
      scrollRafPending = false;
      // 滚动停止后 80ms 触发（避免高频滚动事件）
      const elapsed = Date.now() - lastScrollTime;
      const delay = elapsed < 80 ? 80 - elapsed : 0;
      if (state.scrollRescanTimer) clearTimeout(state.scrollRescanTimer);
      state.scrollRescanTimer = setTimeout(async () => {
        state.scrollRescanTimer = null;
        if (!isContextValid()) return;
        if (!state.translated || state.translating) return;
        // 只翻译视口内未处理节点（快速响应）
        const myToken = state.abortToken;
        state.progress = { total: 0, done: 0, failed: 0 };
        state.translating = true;
        openKeepalive();
        broadcastState();
        // 不立即显示 working badge — 先看是否有内容要翻译
        const context = { url: location.href, title: document.title };
        const result = await streamTranslateViewportOnly(context);
        if (result.aborted || state.abortToken !== myToken) {
          closeKeepalive();
          return;
        }
        state.translating = false;
        closeKeepalive();
        broadcastState();
        // 只有实际翻译了内容才显示 done badge
        if (result.translatedCount > 0) {
          updateBadge("done");
          setTimeout(removeBadge, 1500);
        }
        // 异步触发全量补全（不阻塞，低优先级）
        setTimeout(() => {
          if (state.translated && !state.translating) {
            scheduleRescan("scroll-full", true);
          }
        }, 200);
      }, delay);
    });
  }

  // ---------- Whitelist (skip auto-translate on specified sites) ----------
  // 匹配域名及其所有子域名。例如加入 "example.com" 后，
  // example.com / www.example.com / sub.example.com 均不自动翻译。
  function isWhitelisted(url) {
    const list = state.settings?.whitelist;
    if (!list || !list.length) return false;
    let host;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return false;
    }
    if (!host) return false;
    for (const raw of list) {
      let d = String(raw || "").trim().toLowerCase();
      if (!d) continue;
      // 容错：去掉协议和路径，只保留主机名
      d = d.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "");
      if (!d) continue;
      if (host === d || host.endsWith("." + d)) return true;
    }
    return false;
  }

  // ---------- Auto-translate on load ----------
  async function maybeAutoTranslate() {
    if (state.autoStarted || state.translated || state.translating) return;
    if (!isContextValid()) return;
    state.autoStarted = true;
    const settings = await getSettings();
    state.settings = settings;
    if (!settings.autoTranslate) return;
    // 白名单站点不自动翻译（手动翻译仍可用）
    if (isWhitelisted(location.href)) {
      closeKeepalive();
      return;
    }
    // Pre-warm keepalive + SW connection while page renders
    openKeepalive();
    // Minimal delay — start as soon as DOM is interactive
    setTimeout(() => {
      if (!isContextValid()) return;
      if (isEnglishPage()) {
        translatePage();
      } else {
        closeKeepalive();
      }
    }, 150);
  }

  // ---------- Message handling ----------
  safeRuntimeCall(() => {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      try {
        switch (msg.type) {
          case "TRANSLATE_NOW": {
            // Manual translate button: force translate current page.
            if (state.translated) {
              sendResponse({ ok: true });
              return;
            }
            state.autoStarted = true;
            translatePage();
            sendResponse({ ok: true });
            break;
          }
          case "RESTORE_NOW": {
            // Manual restore button.
            restorePage();
            sendResponse({ ok: true });
            break;
          }
          case "RETRANSLATE": {
            // Refresh button: restore then force re-translation.
            // 清除 processedNodes/originals 让所有节点重新参与翻译。
            // 内存缓存也清空，避免使用旧译文（例如术语表刚改过）。
            restorePage();
            memCache.clear();
            state.autoStarted = true;
            translatePage();
            sendResponse({ ok: true });
            break;
          }
          case "ENABLE_TRANSLATE": {
            state.autoStarted = true;
            if (state.translated) {
              sendResponse({ ok: true });
              return;
            }
            // 白名单站点不自动翻译（用户仍可手动点"翻译本页"）
            if (isWhitelisted(location.href)) {
              sendResponse({ ok: true });
              return;
            }
            // If page is English, translate now.
            if (isEnglishPage()) {
              translatePage();
              sendResponse({ ok: true });
            } else {
              updateBadge("done");
              setTimeout(removeBadge, 2000);
              sendResponse({ ok: true });
            }
            break;
          }
          case "DISABLE_TRANSLATE": {
            state.autoStarted = false;
            restorePage();
            sendResponse({ ok: true });
            break;
          }
          case "SETTINGS_CHANGED": {
            const oldGlossary = state.settings?.glossary;
            state.settings = msg.settings || state.settings;
            // Clear in-memory cache if glossary changed — otherwise cached
            // translations would ignore the new glossary terms.
            const newGlossary = state.settings?.glossary;
            if (JSON.stringify(oldGlossary) !== JSON.stringify(newGlossary)) {
              memCache.clear();
            }
            sendResponse({ ok: true });
            break;
          }
          case "GET_STATE": {
            sendResponse({
              ok: true,
              translated: state.translated,
              translating: state.translating,
            });
            break;
          }
          default:
            sendResponse({ ok: false, error: "unknown" });
        }
      } catch (e) {
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  });
  }, undefined);

  // ---------- Init ----------
  // Pre-warm connection to DeepSeek API (DNS + TLS handshake) for lower TTFT.
  // Using <link rel="preconnect"> triggers browser-level connection pooling.
  (function preconnectAPI() {
    try {
      const link = document.createElement("link");
      link.rel = "preconnect";
      link.href = "https://api.deepseek.com";
      link.crossOrigin = "anonymous";
      document.head.appendChild(link);
    } catch {}
  })();

  maybeAutoTranslate();
})();
