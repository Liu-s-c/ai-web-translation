// options.js - iOS-style settings page logic.

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

  // ---------- Storage ----------
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
        chrome.storage.local.set({ settings: next }, () => {
          // Broadcast change to content scripts / popup.
          chrome.runtime.sendMessage({ type: "SETTINGS_CHANGED", settings: next }).catch(() => {});
          resolve(next);
        });
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

  // ---------- Toast ----------
  let toastTimer = null;
  function toast(text, kind) {
    const el = $("toast");
    el.textContent = text;
    el.className = "toast show" + (kind ? " " + kind : "");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.className = "toast";
    }, 2200);
  }

  // ---------- Render glossary ----------
  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderGlossary() {
    const list = $("glossaryList");
    list.innerHTML = "";
    const items = settings.glossary || [];
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "glossary-empty";
      empty.textContent = "暂无术语。添加术语可统一译法、保护专有名词。";
      list.appendChild(empty);
      return;
    }
    for (let i = 0; i < items.length; i++) {
      const g = items[i];
      const row = document.createElement("div");
      row.className = "glossary-item";
      row.innerHTML = `
        <span class="from" title="${escapeHtml(g.from)}">${escapeHtml(g.from)}</span>
        <span class="arrow">→</span>
        <span class="to" title="${escapeHtml(g.to)}">${escapeHtml(g.to)}</span>
        <button class="del-btn" type="button" data-i="${i}" aria-label="删除">×</button>
      `;
      list.appendChild(row);
    }
    list.querySelectorAll(".del-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const i = parseInt(btn.dataset.i, 10);
        settings.glossary.splice(i, 1);
        await saveSettings({ glossary: settings.glossary });
        renderGlossary();
        toast("已删除");
      });
    });
  }

  // ---------- Render whitelist ----------
  function normalizeDomain(s) {
    return String(s || "")
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "")
      .replace(/:\d+$/, "");
  }

  function renderWhitelist() {
    const list = $("whitelistList");
    list.innerHTML = "";
    const items = settings.whitelist || [];
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "glossary-empty";
      empty.textContent = "暂无白名单。添加域名后，该站点及其子域名将不自动翻译。";
      list.appendChild(empty);
      return;
    }
    for (let i = 0; i < items.length; i++) {
      const d = items[i];
      const row = document.createElement("div");
      row.className = "glossary-item";
      row.innerHTML = `
        <span class="from" title="${escapeHtml(d)}">${escapeHtml(d)}</span>
        <span class="arrow" style="visibility:hidden">→</span>
        <span class="to" style="flex:0;color:var(--label-tertiary);font-size:13px">及其子域名</span>
        <button class="del-btn" type="button" data-i="${i}" aria-label="删除">×</button>
      `;
      list.appendChild(row);
    }
    list.querySelectorAll(".del-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const i = parseInt(btn.dataset.i, 10);
        settings.whitelist.splice(i, 1);
        await saveSettings({ whitelist: settings.whitelist });
        renderWhitelist();
        toast("已删除");
      });
    });
  }

  // ---------- Cache ----------
  async function refreshCacheStats() {
    const resp = await send({ type: "GET_CACHE_STATS" });
    if (resp?.ok) {
      const { count, bytes } = resp.stats;
      const kb = (bytes / 1024).toFixed(1);
      $("cacheStats").textContent = count ? `${count} 条 · ${kb} KB` : "0 条";
    } else {
      $("cacheStats").textContent = "0 条";
    }
  }

  // ---------- Load settings ----------
  async function load() {
    settings = await getSettings();
    $("apiKey").value = settings.apiKey || "";
    renderGlossary();
    renderWhitelist();
    refreshCacheStats();
  }

  // ---------- Wire events ----------
  let saveTimer = null;
  function debouncedSave(partial) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      await saveSettings(partial);
    }, 350);
  }

  document.addEventListener("DOMContentLoaded", () => {
    load();

    // Back button: closes the options tab (best approximation of iOS back).
    $("backBtn").addEventListener("click", () => {
      if (window.history.length > 1) {
        window.history.back();
      } else {
        window.close();
      }
    });

    // API key.
    $("apiKey").addEventListener("input", (e) => {
      const v = e.target.value.trim();
      settings.apiKey = v;
      debouncedSave({ apiKey: v });
    });
    $("toggleKey").addEventListener("click", () => {
      const input = $("apiKey");
      input.type = input.type === "password" ? "text" : "password";
    });

    // Glossary add.
    function addGlossary() {
      const from = $("glossaryFrom").value.trim();
      const to = $("glossaryTo").value.trim();
      if (!from || !to) {
        toast("原文和译文都不能为空", "error");
        return;
      }
      if (!settings.glossary) settings.glossary = [];
      settings.glossary = settings.glossary.filter((g) => g.from !== from);
      settings.glossary.push({ from, to });
      saveSettings({ glossary: settings.glossary }).then(() => {
        $("glossaryFrom").value = "";
        $("glossaryTo").value = "";
        renderGlossary();
        toast("已添加", "success");
      });
    }
    $("addGlossary").addEventListener("click", addGlossary);
    ["glossaryFrom", "glossaryTo"].forEach((id) => {
      $(id).addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          addGlossary();
        }
      });
    });

    // Whitelist add.
    function addWhitelist() {
      const raw = $("whitelistInput").value.trim();
      const d = normalizeDomain(raw);
      if (!d) {
        toast("请输入域名", "error");
        return;
      }
      if (!settings.whitelist) settings.whitelist = [];
      // 去重
      if (settings.whitelist.some((x) => normalizeDomain(x) === d)) {
        toast("该域名已存在", "error");
        return;
      }
      settings.whitelist.push(d);
      saveSettings({ whitelist: settings.whitelist }).then(() => {
        $("whitelistInput").value = "";
        renderWhitelist();
        toast("已添加", "success");
      });
    }
    $("addWhitelist").addEventListener("click", addWhitelist);
    $("whitelistInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        addWhitelist();
      }
    });

    // Clear cache.
    $("clearCacheBtn").addEventListener("click", async (e) => {
      e.preventDefault();
      const resp = await send({ type: "CLEAR_CACHE" });
      if (resp?.ok) {
        toast("缓存已清空", "success");
        refreshCacheStats();
      } else {
        toast("清空失败", "error");
      }
    });
  });
})();
