// popup.js - iOS-style minimal popup. Two toggles + settings link.

(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const DEFAULTS = {
    apiKey: "",
    autoTranslate: false,
    glossary: [],
    skipCodeBlocks: true,
    showOriginalOnHover: true,
    whitelist: [],
  };

  let settings = { ...DEFAULTS };
  let tabState = { translated: false, translating: false };

  // ---------- Storage helpers ----------
  function getSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get("settings", (res) => {
        resolve({ ...DEFAULTS, ...(res.settings || {}) });
      });
    });
  }

  function saveSettings(partial) {
    return new Promise((resolve) => {
      chrome.storage.local.get("settings", (res) => {
        const next = { ...DEFAULTS, ...(res.settings || {}), ...partial };
        chrome.storage.local.set({ settings: next }, () => resolve(next));
      });
    });
  }

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(resp);
          }
        });
      } catch (e) {
        resolve({ ok: false, error: e?.message || String(e) });
      }
    });
  }

  function sendToActiveTab(msg) {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs?.[0];
        if (!tab?.id) {
          resolve({ ok: false, error: "no-tab" });
          return;
        }
        try {
          chrome.tabs.sendMessage(tab.id, msg, (resp) => {
            if (chrome.runtime.lastError) {
              resolve({ ok: false, error: chrome.runtime.lastError.message });
            } else {
              resolve(resp);
            }
          });
        } catch (e) {
          resolve({ ok: false, error: e?.message || String(e) });
        }
      });
    });
  }

  // ---------- UI updates ----------
  function setToggle(el, on) {
    el.classList.toggle("on", on);
    el.setAttribute("aria-checked", on ? "true" : "false");
  }

  function updateStatusPill() {
    const pill = $("statusPill");
    const dot = $("statusDot");
    const text = $("statusText");
    pill.className = "status-pill";
    if (!settings.autoTranslate) {
      text.textContent = "未启用";
    } else if (tabState.translating) {
      pill.classList.add("working");
      text.textContent = "翻译中…";
    } else if (tabState.translated) {
      pill.classList.add("active");
      text.textContent = "已翻译";
    } else {
      pill.classList.add("active");
      text.textContent = "已开启 · 监测中";
    }
  }

  function updateApiKeyStatus() {
    const el = $("apiKeyStatus");
    if (settings.apiKey) {
      el.textContent = "已配置";
      el.classList.add("configured");
    } else {
      el.textContent = "未配置";
      el.classList.remove("configured");
    }
  }

  // ---------- Manual page translate button ----------
  const ICON_TRANSLATE = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M4 5h7M9 3v2c0 4.418-2.239 8-5 8" />
      <path d="M5 9c0 2.144 2.953 3.908 6.7 4" />
      <path d="M12 20l4-9 4 9M14.5 16h3" />
    </svg>`;
  const ICON_RESTORE = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="9 14 4 9 9 4" />
      <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
    </svg>`;

  function updatePageBtn() {
    const btn = $("translatePageBtn");
    const icon = $("pageBtnIcon");
    const label = $("pageBtnLabel");
    const refreshBtn = $("refreshBtn");
    btn.classList.remove("working", "translated");
    if (tabState.translating) {
      btn.classList.add("working");
      icon.innerHTML = ICON_TRANSLATE;
      label.textContent = "翻译中…";
      refreshBtn.disabled = true;
    } else if (tabState.translated) {
      btn.classList.add("translated");
      icon.innerHTML = ICON_RESTORE;
      label.textContent = "恢复原文";
      refreshBtn.disabled = false;
    } else {
      icon.innerHTML = ICON_TRANSLATE;
      label.textContent = "翻译本页";
      refreshBtn.disabled = false;
    }
  }

  async function onPageBtnClick() {
    if (tabState.translating) return; // busy
    if (!settings.apiKey) {
      setStatusHint("请先在设置中配置 API Key");
      return;
    }
    if (tabState.translated) {
      // Restore
      const resp = await sendToActiveTab({ type: "RESTORE_NOW" });
      if (resp?.ok) {
        tabState = { translated: false, translating: false };
        updatePageBtn();
        updateStatusPill();
      }
    } else {
      // Translate now (force, regardless of English detection)
      const resp = await sendToActiveTab({ type: "TRANSLATE_NOW" });
      if (resp?.ok) {
        tabState = { translated: false, translating: true };
        updatePageBtn();
        updateStatusPill();
      } else {
        setStatusHint("无法连接到页面，请刷新后重试");
      }
    }
  }

  // ---------- Refresh (re-translate) button ----------
  async function onRefreshBtnClick() {
    if (tabState.translating) return;
    if (!settings.apiKey) {
      setStatusHint("请先在设置中配置 API Key");
      return;
    }
    // Force re-translation: content script will restore first, then translate.
    const resp = await sendToActiveTab({ type: "RETRANSLATE" });
    if (resp?.ok) {
      tabState = { translated: false, translating: true };
      updatePageBtn();
      updateStatusPill();
    } else {
      setStatusHint("无法连接到页面，请刷新后重试");
    }
  }

  let hintTimer = null;
  function setStatusHint(text) {
    const pill = $("statusPill");
    const text_el = $("statusText");
    const prev = text_el.textContent;
    text_el.textContent = text;
    pill.classList.add("error");
    if (hintTimer) clearTimeout(hintTimer);
    hintTimer = setTimeout(() => {
      text_el.textContent = prev;
      pill.classList.remove("error");
      updateStatusPill();
    }, 2500);
  }

  // ---------- Toggle handlers ----------
  async function onTranslateToggle() {
    const next = !settings.autoTranslate;
    settings.autoTranslate = next;
    await saveSettings({ autoTranslate: next });
    setToggle($("translateToggle"), next);

    if (next) {
      // Turning ON: notify active tab to start monitoring + translate if English.
      const resp = await sendToActiveTab({ type: "ENABLE_TRANSLATE" });
      if (!resp?.ok) {
        // Content script may not be loaded (e.g. chrome:// pages). Silent.
      }
      // Also notify background so future navigations are handled.
      await send({ type: "TRANSLATE_ENABLED" });
    } else {
      // Turning OFF: restore current page.
      await sendToActiveTab({ type: "DISABLE_TRANSLATE" });
      await send({ type: "TRANSLATE_DISABLED" });
      tabState = { translated: false, translating: false };
    }
    updateStatusPill();
  }

  async function onHoverToggle() {
    const next = !settings.showOriginalOnHover;
    settings.showOriginalOnHover = next;
    await saveSettings({ showOriginalOnHover: next });
    setToggle($("hoverToggle"), next);
  }

  // ---------- Tab state polling ----------
  async function refreshTabState() {
    const resp = await sendToActiveTab({ type: "GET_STATE" });
    if (resp?.ok) {
      tabState = {
        translated: !!resp.translated,
        translating: !!resp.translating,
      };
    } else {
      tabState = { translated: false, translating: false };
    }
    updateStatusPill();
    updatePageBtn();
  }

  // ---------- Init ----------
  async function init() {
    settings = await getSettings();
    setToggle($("translateToggle"), settings.autoTranslate);
    setToggle($("hoverToggle"), settings.showOriginalOnHover !== false);
    updateApiKeyStatus();
    await refreshTabState();

    // Listen for state updates from content script.
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === "STATE_UPDATE") {
        tabState = {
          translated: !!msg.translated,
          translating: !!msg.translating,
        };
        updateStatusPill();
        updatePageBtn();
      } else if (msg.type === "SETTINGS_CHANGED") {
        settings = { ...settings, ...msg.settings };
        setToggle($("translateToggle"), settings.autoTranslate);
        setToggle($("hoverToggle"), settings.showOriginalOnHover !== false);
        updateApiKeyStatus();
      }
    });
  }

  // ---------- Wire events ----------
  document.addEventListener("DOMContentLoaded", () => {
    $("translatePageBtn").addEventListener("click", onPageBtnClick);
    $("refreshBtn").addEventListener("click", onRefreshBtnClick);
    $("translateToggle").addEventListener("click", onTranslateToggle);
    $("translateToggle").addEventListener("keydown", (e) => {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        onTranslateToggle();
      }
    });
    $("hoverToggle").addEventListener("click", onHoverToggle);
    $("hoverToggle").addEventListener("keydown", (e) => {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        onHoverToggle();
      }
    });
    $("settingsLink").addEventListener("click", (e) => {
      e.preventDefault();
      if (chrome.runtime.openOptionsPage) {
        chrome.runtime.openOptionsPage();
      } else {
        window.open(chrome.runtime.getURL("options.html"));
      }
    });
    init();
  });
})();
