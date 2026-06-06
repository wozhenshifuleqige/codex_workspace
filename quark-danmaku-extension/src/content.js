(function () {
  const STORAGE_SETTINGS = "qdo:settings";
  const STORAGE_AI_CONFIG = "qdo:ai-config";
  const STORAGE_AI_DRAFT = "qdo:ai-draft";
  const STORAGE_DANMAKU_PREFIX = "qdo:danmaku:";
  const STORAGE_META_PREFIX = "qdo:meta:";

  const defaultSettings = {
    enabled: true,
    fontSize: 26,
    opacity: 0.92,
    speed: 1,
    density: 1,
    offset: 0
  };

  const state = {
    video: null,
    root: null,
    canvas: null,
    ctx: null,
    panel: null,
    settings: { ...defaultSettings },
    comments: [],
    active: [],
    cursor: 0,
    lastTime: 0,
    currentKey: "",
    autoKey: "",
    activeVideoId: "",
    manualMeta: null,
    subtitleSegments: [],
    plotSource: "",
    aiDraft: {
      title: "",
      season: "",
      episode: "",
      plot: "",
      style: "anime",
      density: "medium"
    },
    draftTimer: 0,
    fab: null,
    aiConfig: {
      provider: "local",
      baseUrl: "http://127.0.0.1:8765",
      apiKey: "",
      model: ""
    },
    metaSecond: -1,
    danmakuStatus: {
      type: "empty",
      message: "未导入弹幕"
    },
    raf: 0,
    lanes: [],
    overlay: {
      left: -1,
      top: -1,
      width: 0,
      height: 0,
      fullscreen: false
    }
  };

  init();

  async function init() {
    state.settings = await loadSettings();
    state.aiConfig = await loadAiConfig();
    state.aiDraft = await loadAiDraft();
    createPanel();
    observeVideo();
    window.addEventListener("resize", syncOverlayPosition, { passive: true });
    window.addEventListener("scroll", syncOverlayPosition, { passive: true, capture: true });
    document.addEventListener("fullscreenchange", () => setTimeout(() => {
      attachOverlay();
      syncOverlayPosition();
    }, 50));
  }

  function observeVideo() {
    const observer = new MutationObserver(() => {
      const video = document.querySelector("video");
      if (video && video !== state.video) {
        bindVideo(video);
      } else if (!video) {
        handleVideoMissing();
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    const existing = document.querySelector("video");
    if (existing) bindVideo(existing);
    else handleVideoMissing();
  }

  function handleVideoMissing() {
    state.video = null;
    if (state.fab) state.fab.hidden = true;
    if (state.panel) state.panel.hidden = true;
    if (state.root) state.root.hidden = true;
  }

  async function bindVideo(video) {
    state.video = video;
    if (state.fab) state.fab.hidden = false;
    attachOverlay();
    state.activeVideoId = getActiveVideoId();
    state.autoKey = getAutoVideoKey();
    state.manualMeta = (await getStorage(STORAGE_META_PREFIX + state.autoKey)) || null;
    const key = getVideoKey();
    if (key !== state.currentKey) {
      state.currentKey = key;
      setComments([], { type: "empty", message: "未导入弹幕" });
      loadCachedDanmaku(key);
      updateMeta();
    }

    video.addEventListener("play", startLoop);
    video.addEventListener("pause", renderFrame);
    video.addEventListener("seeked", resetPlayback);
    video.addEventListener("ratechange", renderFrame);
    resetPlayback();
    startLoop();
    setStatus("已连接到播放器。可导入 .xml/.ass/.json 弹幕。");
  }

  function attachOverlay() {
    if (!state.video) return;
    const fullscreenHost = getFullscreenHost();
    const host = fullscreenHost || document.body || document.documentElement;
    if (!host) return;

    if (!state.root) {
      state.root = document.createElement("div");
      state.root.className = "qdo-root";
      state.canvas = document.createElement("canvas");
      state.canvas.className = "qdo-canvas";
      state.root.appendChild(state.canvas);
      state.ctx = state.canvas.getContext("2d");
    }

    state.root.classList.toggle("qdo-fullscreen", Boolean(fullscreenHost));
    if (state.root.parentElement !== host) host.appendChild(state.root);
    syncOverlayPosition();
  }

  function getFullscreenHost() {
    const host = document.fullscreenElement;
    return host && state.video && host !== state.video && host.contains(state.video) ? host : null;
  }

  function syncOverlayPosition() {
    if (!state.video || !state.root) return;
    const rect = state.video.getBoundingClientRect();
    const fullscreenHost = getFullscreenHost();
    const expectedHost = fullscreenHost || document.body || document.documentElement;

    if (expectedHost && state.root.parentElement !== expectedHost) {
      attachOverlay();
      return;
    }

    state.root.classList.toggle("qdo-fullscreen", Boolean(fullscreenHost));

    if (rect.width <= 1 || rect.height <= 1) {
      state.root.hidden = true;
      return;
    }

    state.root.hidden = false;
    let left = rect.left;
    let top = rect.top;

    const next = {
      left: Math.round(left),
      top: Math.round(top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      fullscreen: Boolean(fullscreenHost)
    };

    const changed =
      next.left !== state.overlay.left ||
      next.top !== state.overlay.top ||
      next.width !== state.overlay.width ||
      next.height !== state.overlay.height ||
      next.fullscreen !== state.overlay.fullscreen;

    if (!changed) return;

    state.overlay = next;
    state.root.style.left = `${next.left}px`;
    state.root.style.top = `${next.top}px`;
    state.root.style.width = `${next.width}px`;
    state.root.style.height = `${next.height}px`;
    resizeCanvas();
  }

  function resizeCanvas() {
    if (!state.canvas || !state.root) return;
    const rect = state.root.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    state.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    state.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    state.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    state.lanes = [];
    renderFrame();
  }

  function startLoop() {
    if (state.raf) return;
    const loop = () => {
      renderFrame();
      state.raf = requestAnimationFrame(loop);
    };
    state.raf = requestAnimationFrame(loop);
  }

  function stopLoopIfPaused() {
    if (state.video && state.video.paused && state.raf) {
      cancelAnimationFrame(state.raf);
      state.raf = 0;
    }
  }

  function resetPlayback() {
    if (!state.video) return;
    const current = getDanmakuTime();
    state.cursor = lowerBoundComments(current - 0.2);
    state.active = [];
    state.lanes = [];
    state.lastTime = current;
    renderFrame();
  }

  function renderFrame() {
    if (!state.ctx || !state.canvas || !state.video) return;
    syncOverlayPosition();
    const width = state.canvas.clientWidth;
    const height = state.canvas.clientHeight;
    const ctx = state.ctx;
    ctx.clearRect(0, 0, width, height);

    if (!state.settings.enabled) {
      stopLoopIfPaused();
      return;
    }

    const time = getDanmakuTime();
    if (state.panel && !state.panel.hidden && Math.floor(time) !== state.metaSecond) {
      state.metaSecond = Math.floor(time);
      updateMeta();
    }
    if (Math.abs(time - state.lastTime) > 1.5) resetPlayback();
    state.lastTime = time;

    spawnDueComments(time, width, height);
    drawActiveComments(ctx, time, width);
    stopLoopIfPaused();
  }

  function getDanmakuTime() {
    return Math.max(0, (state.video?.currentTime || 0) + Number(state.settings.offset || 0));
  }

  function spawnDueComments(time, width, height) {
    const lookAhead = state.video?.paused ? 0.05 : 0.35;
    while (state.cursor < state.comments.length && state.comments[state.cursor].time <= time + lookAhead) {
      const comment = state.comments[state.cursor++];
      if (comment.time < time - 0.5) continue;
      if (!passesDensity(comment)) continue;

      const fontSize = Number(comment.size || state.settings.fontSize);
      const text = comment.text;
      const textWidth = measureText(text, fontSize);
      const lane = pickLane(fontSize, height, time);
      const duration = Math.max(4, (8 + textWidth / Math.max(140, width)) / Number(state.settings.speed || 1));
      state.active.push({
        text,
        time: comment.time,
        mode: comment.mode || "scroll",
        color: comment.color || "#ffffff",
        size: fontSize,
        width: textWidth,
        lane,
        y: lane * Math.ceil(fontSize * 1.35) + fontSize + 8,
        duration,
        bornAt: time,
        x: width
      });
      state.lanes[lane] = time + Math.min(1.8, duration / 3);
    }
  }

  function drawActiveComments(ctx, time, width) {
    state.active = state.active.filter((item) => {
      const elapsed = Math.max(0, time - item.bornAt);
      if (item.mode === "top" || item.mode === "bottom") {
        if (elapsed > 4) return false;
        item.x = (width - item.width) / 2;
      } else {
        const distance = width + item.width;
        item.x = width - (elapsed / item.duration) * distance;
        if (item.x + item.width < 0) return false;
      }
      drawText(ctx, item);
      return true;
    });
  }

  function drawText(ctx, item) {
    ctx.save();
    ctx.globalAlpha = Number(state.settings.opacity || 1);
    ctx.font = `700 ${item.size}px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(0, 0, 0, 0.72)";
    ctx.lineWidth = Math.max(3, item.size / 7);
    ctx.fillStyle = item.color;
    ctx.strokeText(item.text, item.x, item.y);
    ctx.fillText(item.text, item.x, item.y);
    ctx.restore();
  }

  function pickLane(fontSize, height, time) {
    const laneHeight = Math.ceil(fontSize * 1.35);
    const laneCount = Math.max(1, Math.floor((height * 0.72) / laneHeight));
    for (let i = 0; i < laneCount; i += 1) {
      if (!state.lanes[i] || state.lanes[i] <= time) return i;
    }
    return Math.floor(Math.random() * laneCount);
  }

  function measureText(text, fontSize) {
    const ctx = state.ctx;
    if (!ctx) return text.length * fontSize;
    ctx.save();
    ctx.font = `700 ${fontSize}px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    const width = ctx.measureText(text).width;
    ctx.restore();
    return width;
  }

  function passesDensity(comment) {
    const density = Number(state.settings.density || 1);
    if (density >= 0.98) return true;
    const hash = Array.from(comment.text).reduce((sum, char) => sum + char.charCodeAt(0), Math.floor(comment.time * 100));
    return (hash % 100) / 100 <= density;
  }

  function lowerBoundComments(time) {
    let lo = 0;
    let hi = state.comments.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (state.comments[mid].time < time) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function createPanel() {
    if (document.querySelector(".qdo-fab")) return;

    const fab = document.createElement("button");
    fab.className = "qdo-fab";
    fab.type = "button";
    fab.textContent = "弹";
    fab.title = "弹幕设置";
    fab.hidden = true;

    const panel = document.createElement("section");
    panel.className = "qdo-panel";
    panel.hidden = true;
    panel.innerHTML = `
      <div class="qdo-title">
        <span>网盘弹幕</span>
        <button class="qdo-close" type="button" title="关闭">×</button>
      </div>
      <div class="qdo-actions">
        <button class="qdo-button" type="button" data-action="import">导入弹幕</button>
        <button class="qdo-button secondary" type="button" data-action="toggle">开启/关闭</button>
        <button class="qdo-button secondary" type="button" data-action="demo">示例弹幕</button>
        <button class="qdo-button secondary" type="button" data-action="testNow">测试当前</button>
        <button class="qdo-button warning" type="button" data-action="clear">清除缓存</button>
      </div>
      <div class="qdo-section">B 站导入</div>
      <label class="qdo-row qdo-wide">链接 <input class="qdo-number" data-bili-input type="text" placeholder="BV / av / ep / 链接"><span></span></label>
      <div class="qdo-actions">
        <button class="qdo-button" type="button" data-action="importBilibili">从 B 站导入</button>
        <button class="qdo-button secondary" type="button" data-action="clearBiliInput">清空链接</button>
      </div>
      <div class="qdo-section">AI 生成</div>
      <div class="qdo-hint">AI 弹幕可基于剧情简介或字幕生成。字幕更贴合时间轴；没有字幕时，可手动输入简介或点击 AI生成简介。</div>
      <label class="qdo-row">剧名 <input class="qdo-number" data-ai-meta="title" type="text" placeholder="例如 银魂"><span></span></label>
      <label class="qdo-row">季数 <input class="qdo-number" data-ai-meta="season" type="number" min="1" step="1" placeholder="可空"><span></span></label>
      <label class="qdo-row">集数 <input class="qdo-number" data-ai-meta="episode" type="number" min="1" step="1" placeholder="可空"><span></span></label>
      <label class="qdo-row qdo-wide">风格 <select class="qdo-number" data-ai-style>
        <option value="anime">动漫吐槽</option>
        <option value="american_drama">美剧轻弹幕</option>
        <option value="explain">剧情解释</option>
        <option value="low_density">低密度陪看</option>
      </select><span></span></label>
      <label class="qdo-row qdo-wide">密度 <select class="qdo-number" data-ai-density>
        <option value="medium">中</option>
        <option value="low">低</option>
        <option value="high">高</option>
      </select><span></span></label>
      <label class="qdo-row qdo-wide">模型 <select class="qdo-number" data-ai-provider>
        <option value="local">本地服务</option>
        <option value="doubao">豆包/火山方舟</option>
        <option value="deepseek">DeepSeek</option>
        <option value="qwen">通义千问</option>
        <option value="openai">OpenAI</option>
        <option value="custom">自定义兼容接口</option>
      </select><span></span></label>
      <label class="qdo-row qdo-wide">地址 <input class="qdo-number" data-ai-base-url type="text" placeholder="https://.../v1"><span></span></label>
      <label class="qdo-row qdo-wide">Key <input class="qdo-number" data-ai-key type="password" placeholder="API Key，仅保存在本机浏览器"><span></span></label>
      <label class="qdo-row qdo-wide">名称 <input class="qdo-number" data-ai-model type="text" placeholder="可空，默认使用供应商推荐模型"><span></span></label>
      <div class="qdo-actions">
        <button class="qdo-button secondary" type="button" data-action="loadSubtitle">导入字幕</button>
        <button class="qdo-button secondary" type="button" data-action="generatePlotSummary">AI生成简介</button>
        <button class="qdo-button secondary" type="button" data-action="clearPlot">清空简介</button>
        <button class="qdo-button" type="button" data-action="generateAi">AI 生成弹幕</button>
        <button class="qdo-button secondary" type="button" data-action="checkAi">检查服务</button>
        <button class="qdo-button secondary" type="button" data-action="saveAiConfig">保存模型配置</button>
      </div>
      <textarea class="qdo-textarea" data-plot-text placeholder="可手动粘贴剧情简介；也可以点击“AI生成简介”自动填充，确认或编辑后再生成弹幕"></textarea>
      <div class="qdo-status" data-subtitle-status>字幕：未导入</div>
      <label class="qdo-row">字号 <input data-setting="fontSize" type="range" min="16" max="42" step="1"><span data-value="fontSize"></span></label>
      <label class="qdo-row">透明 <input data-setting="opacity" type="range" min="0.2" max="1" step="0.05"><span data-value="opacity"></span></label>
      <label class="qdo-row">速度 <input data-setting="speed" type="range" min="0.5" max="2" step="0.1"><span data-value="speed"></span></label>
      <label class="qdo-row">密度 <input data-setting="density" type="range" min="0.1" max="1" step="0.05"><span data-value="density"></span></label>
      <label class="qdo-row">偏移 <input class="qdo-number" data-setting="offset" type="number" step="0.5"><span>秒</span></label>
      <input class="qdo-file" type="file" accept=".xml,.ass,.json,application/json,text/xml,text/plain">
      <input class="qdo-file" data-subtitle-file type="file" accept=".srt,.vtt,.ass,text/plain">
      <input class="qdo-file" data-media-file type="file" accept="audio/*,video/*">
      <div class="qdo-meta"></div>
      <div class="qdo-status"></div>
    `;

    document.documentElement.appendChild(fab);
    document.documentElement.appendChild(panel);
    state.fab = fab;
    state.panel = panel;

    fab.addEventListener("click", () => {
      panel.hidden = !panel.hidden;
      if (!panel.hidden) panel.scrollTop = 0;
      updateMeta();
    });
    panel.querySelector(".qdo-close").addEventListener("click", () => {
      panel.hidden = true;
    });

    panel.querySelectorAll("[data-setting]").forEach((input) => {
      const key = input.dataset.setting;
      input.value = state.settings[key];
      input.addEventListener("input", async () => {
        state.settings[key] = input.type === "number" ? Number(input.value) : Number(input.value);
        await saveSettings();
        refreshSettingLabels();
        resetPlayback();
      });
    });
    refreshSettingLabels();
    refreshAiConfigInputs();
    refreshAiDraftInputs();
    bindAiDraftInputs();
    updateSubtitleStatus();

    const providerInput = panel.querySelector("[data-ai-provider]");
    providerInput.addEventListener("change", () => {
      applyAiProviderPreset(providerInput.value);
    });

    const fileInput = panel.querySelector(".qdo-file");
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      try {
        const comments = await parseDanmakuFile(file);
        setComments(comments, { type: "imported", message: `已导入 ${comments.length} 条` });
        await cacheCurrentDanmaku(comments);
        setStatus(`已导入 ${comments.length} 条弹幕：${file.name}。${buildDanmakuDiagnostic(comments)}`);
      } catch (error) {
        state.danmakuStatus = { type: "error", message: `导入失败：${error.message}` };
        updateMeta();
        setStatus(`导入失败：${error.message}`);
      } finally {
        fileInput.value = "";
      }
    });

    const subtitleInput = panel.querySelector("[data-subtitle-file]");
    subtitleInput.addEventListener("change", async () => {
      const file = subtitleInput.files?.[0];
      if (!file) return;
      try {
        state.subtitleSegments = await parseSubtitleFile(file);
        updateSubtitleStatus();
        setStatus(`已导入字幕 ${state.subtitleSegments.length} 段：${file.name}`);
      } catch (error) {
        setStatus(`字幕导入失败：${error.message}`);
      } finally {
        subtitleInput.value = "";
      }
    });

    const mediaInput = panel.querySelector("[data-media-file]");
    mediaInput.addEventListener("change", async () => {
      const file = mediaInput.files?.[0];
      if (!file) return;
      try {
        state.subtitleSegments = await transcribeMediaFile(file);
        setStatus(`音频识别完成：${state.subtitleSegments.length} 段字幕。现在可以点击 AI 生成弹幕。`);
      } catch (error) {
        setStatus(`音频识别失败：${error.message}`);
      } finally {
        mediaInput.value = "";
      }
    });

    panel.addEventListener("click", async (event) => {
      const button = event.target.closest("[data-action]");
      if (!button) return;
      const action = button.dataset.action;
      if (action === "import") fileInput.click();
      if (action === "toggle") {
        state.settings.enabled = !state.settings.enabled;
        await saveSettings();
        renderFrame();
        setStatus(state.settings.enabled ? "弹幕已开启。" : "弹幕已关闭。");
      }
      if (action === "demo") {
        const comments = createDemoComments();
        setComments(comments, { type: "imported", message: `已导入 ${comments.length} 条示例弹幕` });
        await cacheCurrentDanmaku(comments);
        setStatus("已加载示例弹幕，用于验证叠加层和同步。");
      }
      if (action === "testNow") {
        insertCurrentTimeTestComments();
      }
      if (action === "clear") {
        await removeStorage(STORAGE_DANMAKU_PREFIX + state.currentKey);
        setComments([], { type: "empty", message: "未导入弹幕" });
        setStatus("已清除当前视频缓存弹幕。");
      }
      if (action === "importBilibili") {
        await importBilibiliFromPanel();
      }
      if (action === "clearBiliInput") {
        const input = state.panel.querySelector("[data-bili-input]");
        if (input) input.value = "";
      }
      if (action === "loadSubtitle") {
        subtitleInput.click();
      }
      if (action === "generatePlotSummary") {
        await generatePlotSummaryFromPanel();
      }
      if (action === "clearPlot") {
        clearPlotText();
      }
      if (action === "generateAi") {
        await generateAiDanmakuFromPanel();
      }
      if (action === "checkAi") {
        await checkAiServer();
      }
      if (action === "saveAiConfig") {
        await saveAiConfigFromPanel();
      }
    });
  }

  function refreshAiConfigInputs() {
    if (!state.panel) return;
    const provider = state.panel.querySelector("[data-ai-provider]");
    const baseUrl = state.panel.querySelector("[data-ai-base-url]");
    const apiKey = state.panel.querySelector("[data-ai-key]");
    const model = state.panel.querySelector("[data-ai-model]");
    provider.value = state.aiConfig.provider || "local";
    baseUrl.value = state.aiConfig.baseUrl || "";
    apiKey.value = state.aiConfig.apiKey || "";
    model.value = state.aiConfig.model || "";
  }

  function refreshAiDraftInputs() {
    if (!state.panel) return;
    state.panel.querySelector('[data-ai-meta="title"]').value = state.aiDraft.title || "";
    state.panel.querySelector('[data-ai-meta="season"]').value = state.aiDraft.season || "";
    state.panel.querySelector('[data-ai-meta="episode"]').value = state.aiDraft.episode || "";
    state.panel.querySelector("[data-plot-text]").value = state.aiDraft.plot || "";
    state.panel.querySelector("[data-ai-style]").value = state.aiDraft.style || "anime";
    state.panel.querySelector("[data-ai-density]").value = state.aiDraft.density || "medium";
  }

  function bindAiDraftInputs() {
    if (!state.panel) return;
    const selectors = [
      '[data-ai-meta="title"]',
      '[data-ai-meta="season"]',
      '[data-ai-meta="episode"]',
      "[data-plot-text]",
      "[data-ai-style]",
      "[data-ai-density]"
    ];
    state.panel.querySelectorAll(selectors.join(",")).forEach((input) => {
      input.addEventListener("input", scheduleAiDraftSave);
      input.addEventListener("change", scheduleAiDraftSave);
    });
  }

  function updateSubtitleStatus() {
    const node = state.panel?.querySelector("[data-subtitle-status]");
    if (!node) return;
    node.textContent = state.subtitleSegments.length ? `字幕：${state.subtitleSegments.length} 段` : "字幕：未导入";
  }

  function scheduleAiDraftSave() {
    clearTimeout(state.draftTimer);
    state.draftTimer = setTimeout(saveAiDraftFromPanel, 350);
  }

  async function saveAiDraftFromPanel() {
    if (!state.panel) return;
    state.aiDraft = {
      title: state.panel.querySelector('[data-ai-meta="title"]')?.value.trim() || "",
      season: state.panel.querySelector('[data-ai-meta="season"]')?.value || "",
      episode: state.panel.querySelector('[data-ai-meta="episode"]')?.value || "",
      plot: state.panel.querySelector("[data-plot-text]")?.value || "",
      style: state.panel.querySelector("[data-ai-style]")?.value || "anime",
      density: state.panel.querySelector("[data-ai-density]")?.value || "medium"
    };
    await setStorage(STORAGE_AI_DRAFT, state.aiDraft);
  }

  function applyAiProviderPreset(provider) {
    const presets = {
      local: { baseUrl: "http://127.0.0.1:8765", model: "" },
      doubao: { baseUrl: "https://ark.cn-beijing.volces.com/api/v3", model: "doubao-seed-1-6-flash-250615" },
      deepseek: { baseUrl: "https://api.deepseek.com", model: "deepseek-chat" },
      qwen: { baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-turbo" },
      openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
      custom: { baseUrl: "", model: "" }
    };
    const preset = presets[provider] || presets.custom;
    state.panel.querySelector("[data-ai-base-url]").value = preset.baseUrl;
    state.panel.querySelector("[data-ai-model]").value = preset.model;
  }

  async function saveAiConfigFromPanel() {
    state.aiConfig = getAiConfigFromPanel();
    await setStorage(STORAGE_AI_CONFIG, state.aiConfig);
    setStatus("已保存模型配置。API Key 仅保存在当前浏览器扩展本地存储。");
  }

  function getAiConfigFromPanel() {
    const provider = state.panel.querySelector("[data-ai-provider]")?.value || "local";
    const baseUrl = state.panel.querySelector("[data-ai-base-url]")?.value.trim() || "";
    const model = state.panel.querySelector("[data-ai-model]")?.value.trim() || getDefaultAiModel(provider);
    return {
      provider,
      baseUrl,
      apiKey: state.panel.querySelector("[data-ai-key]")?.value.trim() || "",
      model
    };
  }

  function getDefaultAiModel(provider) {
    const defaults = {
      doubao: "doubao-seed-1-6-flash-250615",
      deepseek: "deepseek-chat",
      qwen: "qwen-turbo",
      openai: "gpt-4o-mini"
    };
    return defaults[provider] || "";
  }

  function refreshAiMetaInputs() {
    if (!state.panel) return;
    const meta = state.manualMeta || {};
    state.panel.querySelectorAll("[data-ai-meta]").forEach((input) => {
      input.value = meta[input.dataset.aiMeta] || "";
    });
  }

  async function saveManualMetaFromPanel() {
    if (!state.panel || !state.autoKey) return;
    const title = state.panel.querySelector('[data-meta="title"]').value.trim();
    const season = Number(state.panel.querySelector('[data-meta="season"]').value);
    const episode = Number(state.panel.querySelector('[data-meta="episode"]').value);

    if (!title) {
      setStatus("请至少填写视频名称。");
      return;
    }

    state.manualMeta = {
      title,
      rawTitle: title,
      season: Number.isFinite(season) && season > 0 ? season : undefined,
      episode: Number.isFinite(episode) && episode > 0 ? episode : undefined,
      manual: true
    };

    await setStorage(STORAGE_META_PREFIX + state.autoKey, state.manualMeta);
    const previousKey = state.currentKey;
    state.currentKey = getVideoKey();
    if (state.comments.length) await cacheCurrentDanmaku(state.comments);
    if (previousKey !== state.currentKey) await loadCachedDanmaku(state.currentKey);
    updateMeta();
    setStatus("已保存手动信息，后续会优先使用该名称匹配和缓存。");
  }

  async function clearManualMeta() {
    if (!state.autoKey) return;
    await removeStorage(STORAGE_META_PREFIX + state.autoKey);
    state.manualMeta = null;
    refreshMetaInputs();
    state.currentKey = getVideoKey();
    await loadCachedDanmaku(state.currentKey);
    updateMeta();
    setStatus("已清除手动信息，恢复自动识别。");
  }

  async function importBilibiliFromPanel() {
    const input = state.panel?.querySelector("[data-bili-input]")?.value.trim();
    if (!input) {
      setStatus("请先输入 B 站链接、BV、av 或 ep 号。");
      return;
    }

    setStatus("正在从 B 站导入弹幕...");
    const result = await sendRuntimeMessage({ type: "qdo:importBilibili", input });
    if (!result.ok) {
      state.danmakuStatus = { type: "error", message: `导入失败：${result.error}` };
      updateMeta();
      setStatus(`B 站导入失败：${result.error}`);
      return;
    }

    const comments = result.comments.map(normalizeComment).filter(Boolean).sort((a, b) => a.time - b.time);
    if (!comments.length) {
      state.danmakuStatus = { type: "error", message: "导入失败：B 站返回空弹幕" };
      updateMeta();
      setStatus("B 站导入失败：返回空弹幕。");
      return;
    }

    setComments(comments, { type: "imported", message: `已导入 ${comments.length} 条` });
    await cacheCurrentDanmaku(comments);
    setStatus(`B 站导入成功：${comments.length} 条。${buildDanmakuDiagnostic(comments)}`);
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { ok: false, error: "扩展后台无响应" });
      });
    });
  }

  async function checkAiServer() {
    const config = getAiConfigFromPanel();
    if (config.provider !== "local") {
      const missing = [];
      if (!config.baseUrl) missing.push("Base URL");
      if (!config.apiKey) missing.push("API Key");
      setStatus(missing.length ? `在线模型配置缺少：${missing.join("、")}` : "在线模型配置已填写。生成时会直接调用该接口。");
      return;
    }
    try {
      const res = await fetch("http://127.0.0.1:8765/health");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setStatus(`AI 服务可用：${data.model || "未配置模型"}`);
    } catch (error) {
      setStatus(`AI 服务不可用：${error.message}。请先启动 local-ai-server。`);
    }
  }

  async function generateAiDanmakuFromPanel() {
    const plot = getPlotText();
    if (!state.subtitleSegments.length && !plot) {
      setStatus("请先导入字幕、手动输入剧情简介，或点击 AI生成简介。");
      return;
    }

    const detected = detectEpisode();
    const style = state.panel.querySelector("[data-ai-style]")?.value || "anime";
    const density = state.panel.querySelector("[data-ai-density]")?.value || "medium";
    const aiConfig = getAiConfigFromPanel();
    await setStorage(STORAGE_AI_CONFIG, aiConfig);
    setStatus(aiConfig.provider === "local" ? "正在请求本地 AI 服务生成弹幕..." : "正在请求在线模型生成弹幕...");

    try {
      const payload = {
        title: detected.title || detected.rawTitle || document.title,
        season: detected.season || null,
        episode: detected.episode || null,
        duration: Number.isFinite(state.video?.duration) ? state.video.duration : null,
        style,
        density,
        no_spoilers: true,
        plot,
        plot_source: state.plotSource || "",
        subtitles: state.subtitleSegments
      };
      const data = aiConfig.provider === "local"
        ? await generateWithLocalServer(payload)
        : await generateWithOnlineModel(aiConfig, payload);
      const comments = (data.comments || data.danmaku || []).map(normalizeComment).filter(Boolean).sort((a, b) => a.time - b.time);
      if (!comments.length) throw new Error("AI 服务没有返回有效弹幕");
      setComments(comments, { type: "imported", message: `已导入 ${comments.length} 条 AI 弹幕` });
      await cacheCurrentDanmaku(comments);
      setStatus(buildAiGenerationStatus(data, comments));
    } catch (error) {
      state.danmakuStatus = { type: "error", message: `AI 生成失败：${error.message}` };
      updateMeta();
      setStatus(`AI 生成失败：${error.message}`);
    }
  }

  async function generateWithLocalServer(payload) {
    const res = await fetch("http://127.0.0.1:8765/generate-danmaku", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function generateWithOnlineModel(config, payload) {
    const result = await sendRuntimeMessage({
      type: "qdo:generateOnlineDanmaku",
      config,
      payload
    });
    if (!result.ok) throw new Error(result.error || "在线模型请求失败");
    return result;
  }

  function buildAiGenerationStatus(data, comments) {
    const target = Number(data.targetCount || data.target_count);
    const actual = comments.length;
    const prefix = Number.isFinite(target) && target > 0
      ? `AI 弹幕生成完成：目标 ${target} 条，实际 ${actual} 条。`
      : `AI 弹幕生成完成：${actual} 条。`;
    const lowCountHint = Number.isFinite(target) && actual < Math.floor(target * 0.5)
      ? "模型返回弹幕偏少，可尝试更换模型或补充更详细简介。"
      : "";
    return `${prefix}${lowCountHint}${buildDanmakuDiagnostic(comments)}`;
  }

  async function searchPlotCnFromPanel() {
    const searchMeta = getPlotSearchMeta();
    const title = searchMeta.title;
    if (!title) {
      setStatus("请先在 AI 生成区域填写剧名。");
      return;
    }

    setStatus(`正在搜索剧情：${searchMeta.query}`);
    try {
      const data = await sendRuntimeMessage({
        type: "qdo:searchPlotCn",
        payload: {
          query: searchMeta.query,
          title,
          season: searchMeta.season || null,
          episode: searchMeta.episode || null,
          category: "anime"
        }
      });
      if (!data.ok) throw new Error(data.error || "搜索失败");
      const candidates = data.candidates || [];
      if (!candidates.length) {
        setStatus("没有搜索到可用剧情摘要。可以手动粘贴剧情简介后生成。");
        return;
      }

      const best = candidates[0];
      state.plotSource = `${best.source || "unknown"} ${best.url || ""}`.trim();
      const textarea = state.panel.querySelector("[data-plot-text]");
      textarea.value = `${best.title || title}\n\n${best.summary || ""}`.trim();
      setStatus(`已找到剧情摘要：${best.source || "未知来源"}。请确认或编辑后点击 AI 生成弹幕。`);
    } catch (error) {
      setStatus(`剧情搜索失败：${error.message}。可手动粘贴剧情简介后生成。`);
    }
  }

  async function generatePlotSummaryFromPanel() {
    const searchMeta = getPlotSearchMeta();
    if (!searchMeta.title) {
      setStatus("请先在 AI 生成区域填写剧名。");
      return;
    }

    const aiConfig = getAiConfigFromPanel();
    await setStorage(STORAGE_AI_CONFIG, aiConfig);
    if (aiConfig.provider === "local") {
      setStatus("AI生成简介需要选择在线模型；本地服务暂不提供该快捷能力。");
      return;
    }

    const prompt = buildPlotSummaryPrompt(searchMeta.title, searchMeta.season, searchMeta.episode);
    setStatus(`正在生成简介：${prompt}`);
    try {
      const result = await sendRuntimeMessage({
        type: "qdo:generatePlotSummary",
        config: aiConfig,
        payload: {
          prompt,
          title: searchMeta.title,
          season: searchMeta.season || null,
          episode: searchMeta.episode || null
        }
      });
      if (!result.ok) throw new Error(result.error || "简介生成失败");
      const textarea = state.panel.querySelector("[data-plot-text]");
      textarea.value = result.summary || "";
      state.plotSource = `AI生成 ${aiConfig.provider}`;
      await saveAiDraftFromPanel();
      setStatus("AI 简介已生成。请确认或编辑后点击 AI 生成弹幕。");
    } catch (error) {
      setStatus(`AI生成简介失败：${error.message}`);
    }
  }

  function buildPlotSummaryPrompt(title, season, episode) {
    const name = `《${title}》`;
    if (season && episode) return `请生成${name}${toChineseOrdinal(season)}季第${episode}集剧情简介`;
    if (episode) return `请生成${name}第${episode}集剧情简介`;
    if (season) return `请生成${name}${toChineseOrdinal(season)}季剧情简介`;
    return `请生成${name}剧情简介`;
  }

  function getPlotText() {
    return (state.panel?.querySelector("[data-plot-text]")?.value || "").trim();
  }

  function clearPlotText() {
    const textarea = state.panel?.querySelector("[data-plot-text]");
    if (textarea) textarea.value = "";
    state.plotSource = "";
    saveAiDraftFromPanel();
    setStatus("已清空剧情简介。");
  }

  function getPlotSearchMeta() {
    const title = state.panel?.querySelector('[data-ai-meta="title"]')?.value.trim() || "";
    const seasonInput = Number(state.panel?.querySelector('[data-ai-meta="season"]')?.value);
    const episodeInput = Number(state.panel?.querySelector('[data-ai-meta="episode"]')?.value);
    const season = Number.isFinite(seasonInput) && seasonInput > 0 ? seasonInput : undefined;
    const episode = Number.isFinite(episodeInput) && episodeInput > 0 ? episodeInput : undefined;
    return {
      title,
      season,
      episode,
      query: buildPlotSearchQuery(title, season, episode)
    };
  }

  function buildPlotSearchQuery(title, season, episode) {
    const normalizedTitle = String(title || "").trim();
    if (!normalizedTitle) return "";
    if (season && episode) return `${normalizedTitle}${toChineseOrdinal(season)}季第${episode}集剧情简介`;
    if (episode) return `${normalizedTitle}第${episode}集剧情简介`;
    if (season) return `${normalizedTitle}${toChineseOrdinal(season)}季剧情简介`;
    return `${normalizedTitle}剧情简介`;
  }

  function toChineseOrdinal(value) {
    return `第${toChineseNumber(value)}`;
  }

  function toChineseNumber(value) {
    const n = Number(value);
    const digits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
    if (!Number.isFinite(n) || n <= 0) return String(value);
    if (n < 10) return digits[n];
    if (n === 10) return "十";
    if (n < 20) return `十${digits[n % 10]}`;
    if (n < 100) {
      const tens = Math.floor(n / 10);
      const ones = n % 10;
      return `${digits[tens]}十${ones ? digits[ones] : ""}`;
    }
    return String(n);
  }

  async function transcribeMediaFile(file) {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch("http://127.0.0.1:8765/transcribe", {
      method: "POST",
      body: form
    });
    if (!res.ok) throw new Error(`本地转写服务请求失败：HTTP ${res.status}`);
    const data = await res.json();
    const segments = data.segments || data.subtitles || [];
    if (!segments.length) throw new Error("转写服务没有返回字幕片段");
    return segments.map(normalizeSubtitleSegment).filter(Boolean);
  }

  function refreshSettingLabels() {
    if (!state.panel) return;
    state.panel.querySelectorAll("[data-setting]").forEach((input) => {
      const key = input.dataset.setting;
      input.value = state.settings[key];
    });
    state.panel.querySelectorAll("[data-value]").forEach((label) => {
      const key = label.dataset.value;
      if (key === "density") {
        label.textContent = `${Math.round(Number(state.settings[key]) * 100)}%`;
      } else {
        label.textContent = Number(state.settings[key]).toFixed(key === "fontSize" ? 0 : 2);
      }
    });
  }

  async function parseDanmakuFile(file) {
    const text = await file.text();
    const lowerName = file.name.toLowerCase();
    let comments;
    if (lowerName.endsWith(".xml") || text.trim().startsWith("<")) comments = parseBilibiliXml(text);
    else if (lowerName.endsWith(".ass")) comments = parseAss(text);
    else if (lowerName.endsWith(".json")) comments = parseJson(text);
    else throw new Error("暂不支持该文件格式");

    const rawCount = comments.length;
    comments = comments.map(normalizeComment).filter(Boolean).sort((a, b) => a.time - b.time);
    if (!comments.length) {
      if (rawCount > 0) throw new Error("文件中有弹幕记录，但缺少可识别的时间或文本字段");
      throw new Error("没有解析到有效弹幕");
    }
    return comments;
  }

  function parseBilibiliXml(text) {
    const doc = new DOMParser().parseFromString(text, "text/xml");
    const nodes = Array.from(doc.querySelectorAll("d"));
    if (!nodes.length) throw new Error("XML 没有找到 B 站 <d> 弹幕节点");
    return nodes.map((node) => {
      const parts = (node.getAttribute("p") || "").split(",");
      const mode = parts[1] === "5" ? "top" : parts[1] === "4" ? "bottom" : "scroll";
      return {
        time: Number(parts[0]),
        mode,
        size: Number(parts[2]) || undefined,
        color: intToColor(Number(parts[3])),
        text: node.textContent || "",
        source: "bilibili-xml"
      };
    });
  }

  function parseAss(text) {
    const lines = text.split(/\r?\n/);
    let inEvents = false;
    let format = [];
    const comments = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^\[Events\]/i.test(trimmed)) {
        inEvents = true;
        continue;
      }
      if (!inEvents) continue;
      if (/^\[/.test(trimmed)) break;
      if (/^Format:/i.test(trimmed)) {
        format = trimmed.replace(/^Format:\s*/i, "").split(",").map((part) => part.trim().toLowerCase());
        continue;
      }
      if (!/^Dialogue:/i.test(trimmed)) continue;
      const raw = trimmed.replace(/^Dialogue:\s*/i, "");
      const parts = splitAssDialogue(raw, Math.max(format.length, 10));
      const get = (name, fallbackIndex) => parts[format.indexOf(name) >= 0 ? format.indexOf(name) : fallbackIndex] || "";
      comments.push({
        time: parseAssTime(get("start", 1)),
        mode: "scroll",
        text: cleanAssText(get("text", parts.length - 1)),
        source: "ass"
      });
    }
    if (!comments.length) throw new Error("ASS 没有找到 Dialogue 弹幕行");
    return comments;
  }

  async function parseSubtitleFile(file) {
    const text = await file.text();
    const name = file.name.toLowerCase();
    let segments;
    if (name.endsWith(".ass")) segments = parseAssSubtitle(text);
    else if (name.endsWith(".vtt")) segments = parseVttSubtitle(text);
    else segments = parseSrtSubtitle(text);
    segments = segments.map(normalizeSubtitleSegment).filter(Boolean).sort((a, b) => a.start - b.start);
    if (!segments.length) throw new Error("没有解析到有效字幕片段");
    return segments;
  }

  function parseSrtSubtitle(text) {
    return text
      .replace(/\r/g, "")
      .split(/\n\s*\n/)
      .map((block) => {
        const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
        const timeLineIndex = lines.findIndex((line) => line.includes("-->"));
        if (timeLineIndex < 0) return null;
        const [start, end] = lines[timeLineIndex].split("-->").map((item) => parseSubtitleTime(item.trim()));
        const content = lines.slice(timeLineIndex + 1).join(" ").trim();
        return { start, end, text: content };
      })
      .filter(Boolean);
  }

  function parseVttSubtitle(text) {
    return parseSrtSubtitle(text.replace(/^WEBVTT[^\n]*\n/i, ""));
  }

  function parseAssSubtitle(text) {
    return parseAss(text).map((item) => ({
      start: item.time,
      end: item.time + 3,
      text: item.text
    }));
  }

  function parseSubtitleTime(value) {
    const normalized = String(value).replace(",", ".").split(/\s+/)[0];
    const parts = normalized.split(":").map(Number);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return Number(normalized);
  }

  function normalizeSubtitleSegment(raw) {
    const text = String(raw.text ?? raw.content ?? "").replace(/\s+/g, " ").trim();
    const start = Number(raw.start ?? raw.time ?? raw.t);
    const end = Number(raw.end ?? raw.stop ?? start + 3);
    if (!text || !Number.isFinite(start)) return null;
    return {
      start: Math.max(0, start),
      end: Number.isFinite(end) ? Math.max(start, end) : start + 3,
      text
    };
  }

  function splitAssDialogue(raw, expected) {
    const parts = raw.split(",");
    if (parts.length <= expected) return parts;
    return parts.slice(0, expected - 1).concat(parts.slice(expected - 1).join(","));
  }

  function parseAssTime(value) {
    const match = String(value).match(/(\d+):(\d{1,2}):(\d{1,2})(?:[.](\d{1,2}))?/);
    if (!match) return 0;
    const [, h, m, s, cs = "0"] = match;
    return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(cs.padEnd(2, "0")) / 100;
  }

  function cleanAssText(text) {
    return String(text)
      .replace(/\{[^}]*\}/g, "")
      .replace(/\\N/g, " ")
      .replace(/\\h/g, " ")
      .trim();
  }

  function parseJson(text) {
    const data = JSON.parse(text);
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.comments)) return data.comments;
    if (Array.isArray(data.danmaku)) return data.danmaku;
    throw new Error("JSON 需要是数组，或包含 comments/danmaku 数组");
  }

  function normalizeComment(raw) {
    const text = String(raw.text ?? raw.content ?? raw.m ?? "").trim();
    const time = normalizeCommentTime(raw);
    if (!text || !Number.isFinite(time)) return null;
    return {
      time: Math.max(0, time),
      text,
      mode: raw.mode || "scroll",
      color: normalizeColor(raw.color),
      size: Number(raw.size) || undefined,
      source: raw.source || "local"
    };
  }

  function normalizeCommentTime(raw) {
    const progress = raw.progress ?? raw.progressMs;
    if (progress !== undefined && progress !== null && progress !== "") {
      return parseTimeValue(progress, true);
    }

    const value = raw.time ?? raw.t ?? raw.stime ?? raw.start ?? raw.startTime;
    return parseTimeValue(value, false);
  }

  function parseTimeValue(value, forceMilliseconds) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      const clock = parseClockTime(trimmed);
      if (Number.isFinite(clock)) return clock;
      value = trimmed;
    }

    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return NaN;
    if (forceMilliseconds) return numeric / 1000;

    const duration = Number.isFinite(state.video?.duration) ? state.video.duration : 0;
    const looksLikeMilliseconds = numeric > 1000 && (!duration || numeric > duration + 300);
    return looksLikeMilliseconds ? numeric / 1000 : numeric;
  }

  function parseClockTime(value) {
    const match = String(value).match(/^(\d+):(\d{1,2})(?::(\d{1,2}(?:[.]\d+)?))?$/);
    if (!match) return NaN;
    if (match[3] === undefined) return Number(match[1]) * 60 + Number(match[2]);
    return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  }

  function intToColor(value) {
    if (!Number.isFinite(value) || value < 0) return "#ffffff";
    return `#${value.toString(16).padStart(6, "0").slice(-6)}`;
  }

  function normalizeColor(value) {
    if (typeof value === "number") return intToColor(value);
    if (typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)) return value;
    return "#ffffff";
  }

  function setComments(comments, status) {
    if (status) state.danmakuStatus = status;
    if (!comments.length && !status) state.danmakuStatus = { type: "empty", message: "未导入弹幕" };
    state.comments = comments.slice().sort((a, b) => a.time - b.time);
    resetPlayback();
    updateMeta();
  }

  function insertCurrentTimeTestComments() {
    const base = getDanmakuTime();
    const comments = [
      { time: base + 0.02, text: "当前时间测试弹幕 1", color: "#ffffff", mode: "scroll", source: "test" },
      { time: base + 0.8, text: "如果看到这条，渲染层正常", color: "#93c5fd", mode: "scroll", source: "test" },
      { time: base + 1.5, text: "看不到导入弹幕，多半是时间轴不匹配", color: "#fbbf24", mode: "scroll", source: "test" }
    ];
    setComments(state.comments.concat(comments), { type: "imported", message: `已导入 ${state.comments.length + comments.length} 条（含测试弹幕）` });
    setStatus(`已插入当前时间测试弹幕。${buildDanmakuDiagnostic(state.comments)}`);
  }

  function createDemoComments() {
    const base = Math.max(0, state.video?.currentTime || 0);
    return [
      { time: base + 1, text: "弹幕层已加载", color: "#ffffff", mode: "scroll" },
      { time: base + 3, text: "拖动进度条会重新同步", color: "#93c5fd", mode: "scroll" },
      { time: base + 5, text: "可导入 B 站 XML / ASS / JSON", color: "#fbbf24", mode: "scroll" },
      { time: base + 7, text: "后续可接入自动匹配和 AI 生成", color: "#86efac", mode: "scroll" }
    ];
  }

  function getVideoKey() {
    return getAutoVideoKey();
  }

  function getAutoVideoKey() {
    return `${state.activeVideoId || getActiveVideoId()}:auto`.slice(0, 240);
  }

  function getActiveVideoId() {
    const detected = detectEpisode(true);
    const raw = detected.rawTitle || document.title || state.video?.currentSrc || location.pathname;
    return `${location.host}:${raw}`.slice(0, 180);
  }

  function detectEpisode(autoOnly = false) {
    const candidates = [
      document.title,
      state.video?.getAttribute("title"),
      state.video?.currentSrc?.split("/").pop(),
      location.pathname.split("/").filter(Boolean).pop(),
      ...Array.from(document.querySelectorAll("[title]")).slice(0, 20).map((node) => node.getAttribute("title")),
      ...Array.from(document.querySelectorAll(".filename, .file-name, .video-title, [class*='file'], [class*='title']")).slice(0, 20).map((node) => node.textContent)
    ].filter(Boolean);

    const rawTitle = candidates.find((value) => /\.(mp4|mkv|mov|avi|flv|webm)$/i.test(value)) || candidates[0] || "";
    const cleaned = decodeURIComponent(rawTitle)
      .replace(/\.(mp4|mkv|mov|avi|flv|webm)$/i, "")
      .replace(/\[[^\]]+\]/g, " ")
      .replace(/\b(1080p|2160p|720p|4k|x264|x265|h264|h265|hevc|web-dl|bluray)\b/gi, " ")
      .replace(/[._-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const se = cleaned.match(/\bS(\d{1,2})E(\d{1,3})\b/i);
    const cnEpisode = cleaned.match(/(?:第\s*)?(\d{1,4})\s*(?:集|话|話)/);
    return {
      rawTitle,
      title: cleaned.replace(/\bS\d{1,2}E\d{1,3}\b/i, "").replace(/(?:第\s*)?\d{1,4}\s*(?:集|话|話)/, "").trim(),
      season: se ? Number(se[1]) : undefined,
      episode: se ? Number(se[2]) : cnEpisode ? Number(cnEpisode[1]) : undefined
    };
  }

  function updateMeta() {
    if (!state.panel) return;
    const meta = state.panel.querySelector(".qdo-meta");
    const detected = detectEpisode();
    const parts = [
      detected.title ? `识别：${detected.title}` : "",
      detected.season ? `S${String(detected.season).padStart(2, "0")}` : "",
      detected.episode ? `E${String(detected.episode).padStart(2, "0")}` : "",
      getDanmakuLabel()
    ].filter(Boolean);
    if (state.comments.length) {
      const first = state.comments[0].time;
      const last = state.comments[state.comments.length - 1].time;
      parts.push(`范围 ${formatTime(first)}-${formatTime(last)}`);
      if (state.video) parts.push(`当前 ${formatTime(getDanmakuTime())}`);
    }
    meta.textContent = parts.join(" · ");
  }

  function getDanmakuLabel() {
    if (state.comments.length) {
      if (state.danmakuStatus.type === "cached") return `缓存 ${state.comments.length} 条`;
      return `已导入 ${state.comments.length} 条`;
    }
    if (state.danmakuStatus.type === "error") return state.danmakuStatus.message;
    return "未导入弹幕";
  }

  function buildDanmakuDiagnostic(comments) {
    if (!comments.length) return "没有可显示弹幕。";
    const sorted = comments.slice().sort((a, b) => a.time - b.time);
    const first = sorted[0].time;
    const last = sorted[sorted.length - 1].time;
    const current = getDanmakuTime();
    const messages = [`时间范围 ${formatTime(first)}-${formatTime(last)}，当前 ${formatTime(current)}`];
    if (first > 300) messages.push("第一条弹幕较晚，若不符合预期可能是时间单位问题");
    if (current > last + 5) messages.push("当前进度已超过最后一条弹幕，可回到前面或调整偏移");
    if (current < first - 30) messages.push("当前进度早于第一条弹幕，需要继续播放一段时间");
    return messages.join("；") + "。";
  }

  function formatTime(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function setStatus(message) {
    if (!state.panel) return;
    const status = state.panel.querySelector(".qdo-status");
    status.textContent = message;
  }

  async function loadCachedDanmaku(key) {
    if (!key) return;
    const cached = await getStorage(STORAGE_DANMAKU_PREFIX + key);
    if (Array.isArray(cached)) {
      const comments = cached.map(normalizeComment).filter(Boolean).sort((a, b) => a.time - b.time);
      setComments(comments, { type: "cached", message: `缓存 ${comments.length} 条` });
      setStatus(`已自动加载缓存弹幕：${comments.length} 条。${buildDanmakuDiagnostic(comments)}`);
    } else {
      if (!state.comments.length) {
        setComments([], { type: "empty", message: "未导入弹幕" });
        setStatus("未导入弹幕。请先导入 .xml/.ass/.json，当前版本不会自动抓取 B 站弹幕。");
      }
    }
  }

  async function cacheCurrentDanmaku(comments) {
    if (!state.currentKey) state.currentKey = getVideoKey();
    await setStorage(STORAGE_DANMAKU_PREFIX + state.currentKey, comments);
  }

  async function loadSettings() {
    const stored = await getStorage(STORAGE_SETTINGS);
    return { ...defaultSettings, ...(stored || {}) };
  }

  async function loadAiConfig() {
    const stored = await getStorage(STORAGE_AI_CONFIG);
    return {
      provider: "local",
      baseUrl: "http://127.0.0.1:8765",
      apiKey: "",
      model: "",
      ...(stored || {})
    };
  }

  async function loadAiDraft() {
    const stored = await getStorage(STORAGE_AI_DRAFT);
    return {
      title: "",
      season: "",
      episode: "",
      plot: "",
      style: "anime",
      density: "medium",
      ...(stored || {})
    };
  }

  async function saveSettings() {
    await setStorage(STORAGE_SETTINGS, state.settings);
  }

  function getStorage(key) {
    return new Promise((resolve) => {
      chrome.storage.local.get(key, (data) => resolve(data[key]));
    });
  }

  function setStorage(key, value) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [key]: value }, resolve);
    });
  }

  function removeStorage(key) {
    return new Promise((resolve) => {
      chrome.storage.local.remove(key, resolve);
    });
  }
})();
