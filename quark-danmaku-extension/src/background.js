chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) return false;
  if (message.type === "qdo:importBilibili") {
    importBilibiliDanmaku(message.input)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
  if (message.type === "qdo:generateOnlineDanmaku") {
    generateOnlineDanmaku(message.config, message.payload)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
  if (message.type === "qdo:generatePlotSummary") {
    generatePlotSummary(message.config, message.payload)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
  if (message.type === "qdo:searchPlotCn") {
    searchPlotCn(message.payload)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
  return false;
});

async function generateOnlineDanmaku(config, payload) {
  const baseUrl = String(config?.baseUrl || "").replace(/\/+$/, "");
  const apiKey = String(config?.apiKey || "");
  const model = String(config?.model || getDefaultModel(config?.provider) || "");
  if (!baseUrl || !apiKey || !model) {
    throw new Error("请先填写在线模型的 Base URL 和 API Key");
  }

  const prompt = buildDanmakuPrompt(payload);
  let comments = await requestOnlineDanmaku(baseUrl, apiKey, model, prompt);
  if (!comments.length) throw new Error("在线模型没有返回有效弹幕");
  if (comments.length < Math.floor(prompt.target_count * 0.5)) {
    const supplementPrompt = buildSupplementPrompt(prompt, comments);
    const supplement = await requestOnlineDanmaku(baseUrl, apiKey, model, supplementPrompt);
    comments = mergeComments(comments, supplement);
  }
  comments.sort((a, b) => a.time - b.time);
  comments = comments.slice(0, 300);
  return { comments, targetCount: prompt.target_count, actualCount: comments.length };
}

function getDefaultModel(provider) {
  const defaults = {
    doubao: "doubao-seed-1-6-flash-250615",
    deepseek: "deepseek-chat",
    qwen: "qwen-turbo",
    openai: "gpt-4o-mini"
  };
  return defaults[provider] || "";
}

async function requestOnlineDanmaku(baseUrl, apiKey, model, prompt) {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content: "你是 AI 陪看弹幕生成器。只输出 JSON 数组，不要解释。每项包含 time 和 text，可选 color/mode。必须严格输出 JSON。"
        },
        {
          role: "user",
          content: JSON.stringify(prompt)
        }
      ],
      temperature: 0.85
    })
  });
  if (!res.ok) throw new Error(`在线模型请求失败：HTTP ${res.status}`);

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || "[]";
  return parseJsonArray(content).map(normalizeOnlineComment).filter(Boolean);
}

function buildSupplementPrompt(prompt, existing) {
  const remaining = Math.max(10, prompt.target_count - existing.length);
  return {
    ...prompt,
    target_count: remaining,
    supplement: true,
    existing_times: existing.map((item) => Math.round(item.time)).slice(0, 260),
    instruction: [
      ...(prompt.instruction || []),
      `这是补生成请求。已有 ${existing.length} 条弹幕，还需要补充约 ${remaining} 条。`,
      "请避开 existing_times 附近 3 秒内的时间点。",
      "补充弹幕仍需覆盖全片，不要集中在开头或结尾。"
    ]
  };
}

function mergeComments(primary, extra) {
  const merged = [];
  const seen = new Set();
  for (const item of [...primary, ...extra]) {
    const key = `${Math.round(item.time * 2) / 2}:${item.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged.sort((a, b) => a.time - b.time);
}

async function generatePlotSummary(config, payload) {
  const baseUrl = String(config?.baseUrl || "").replace(/\/+$/, "");
  const apiKey = String(config?.apiKey || "");
  const model = String(config?.model || getDefaultModel(config?.provider) || "");
  if (!baseUrl || !apiKey || !model) {
    throw new Error("请先填写在线模型的 Base URL 和 API Key");
  }

  const prompt = String(payload?.prompt || "").trim();
  if (!prompt) throw new Error("缺少简介生成提示词");

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content: "你是影视/动画剧情简介助手。输出中文纯文本简介，不要使用 Markdown，不要编造自己不知道的细节；如果不确定，请用较泛化的简介。控制在 300 字以内。"
        },
        {
          role: "user",
          content: `${prompt}。要求：适合后续生成陪看弹幕，概括主要情节、人物冲突和氛围，不要输出弹幕。`
        }
      ],
      temperature: 0.7
    })
  });
  if (!res.ok) throw new Error(`在线模型请求失败：HTTP ${res.status}`);
  const data = await res.json();
  const summary = String(data?.choices?.[0]?.message?.content || "").trim();
  if (!summary) throw new Error("在线模型没有返回简介");
  return { summary };
}

function buildDanmakuPrompt(payload) {
  const duration = Number(payload?.duration) || 1440;
  const subtitles = Array.isArray(payload?.subtitles) ? payload.subtitles.slice(0, 120) : [];
  const targetCount = calculateTargetCount(duration, payload?.density);
  return {
    title: payload?.title || "",
    season: payload?.season || null,
    episode: payload?.episode || null,
    duration,
    style: payload?.style || "anime",
    density: payload?.density || "medium",
    target_count: targetCount,
    no_spoilers: true,
    instruction: [
      "生成中文短弹幕，不要超过 24 个字。",
      "time 必须是秒，落在 0 到 duration 内。",
      "必须尽量生成接近 target_count 条弹幕，允许上下浮动 15%。",
      "不要只输出少量总结式弹幕；高密度时每分钟都应有多条弹幕。",
      "弹幕时间要覆盖全片，不要集中在开头、中段或结尾。",
      "如果输入包含字幕，可围绕同一字幕片段生成多条不同角度的短弹幕。",
      "如果输入只有剧情简介，请按开场、推进、高潮、收束均匀铺开。",
      "不要假装是真实观众弹幕。",
      "只基于给定字幕或剧情摘要生成，不要编造后续剧情。",
      "如果没有分段时间，按开场、推进、高潮、收束均匀分布。"
    ],
    plot: String(payload?.plot || "").slice(0, 1800),
    plot_source: payload?.plot_source || "",
    subtitles: subtitles.map((item) => ({
      start: item.start,
      end: item.end,
      text: item.text
    }))
  };
}

function calculateTargetCount(duration, density) {
  const rates = { low: 2, medium: 4, high: 8 };
  const minutes = Math.max(1, Number(duration || 1440) / 60);
  const rate = rates[density] || rates.medium;
  return Math.max(20, Math.min(300, Math.round(minutes * rate)));
}

function parseJsonArray(text) {
  let cleaned = String(text || "").trim();
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) cleaned = fenced[1].trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start >= 0 && end > start) cleaned = cleaned.slice(start, end + 1);
  const data = JSON.parse(cleaned);
  if (!Array.isArray(data)) throw new Error("在线模型输出不是 JSON 数组");
  return data;
}

function normalizeOnlineComment(raw) {
  const time = Number(raw?.time ?? raw?.t);
  const text = String(raw?.text ?? raw?.content ?? "").trim();
  if (!Number.isFinite(time) || !text) return null;
  return {
    time: Math.max(0, time),
    text: text.slice(0, 40),
    mode: raw.mode || "scroll",
    color: /^#[0-9a-f]{6}$/i.test(raw.color || "") ? raw.color : "#ffffff",
    source: "online-ai"
  };
}

async function searchPlotCn(payload) {
  const title = String(payload?.title || "").trim();
  if (!title) throw new Error("请先填写或识别视频名称");
  const query = String(payload?.query || "").trim() || [title, payload?.season ? `第${payload.season}季` : "", payload?.episode ? `第${payload.episode}集` : "", "剧情 简介"].filter(Boolean).join(" ");
  const results = await Promise.allSettled([
    searchBangumi(title),
    searchBaiduBaike(query, title),
    searchMoegirl(query, title)
  ]);
  const candidates = results
    .flatMap((item) => item.status === "fulfilled" ? item.value : [])
    .map((item) => ({ ...item, summary: cleanText(item.summary).slice(0, 900) }))
    .filter((item) => item.summary.length >= 20);
  const seen = new Set();
  const deduped = [];
  for (const item of candidates) {
    const key = `${item.source}:${item.title}:${item.summary.slice(0, 40)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return { query, candidates: deduped.slice(0, 5) };
}

async function searchBangumi(title) {
  const url = new URL(`https://api.bgm.tv/search/subject/${encodeURIComponent(title)}`);
  url.searchParams.set("type", "2");
  url.searchParams.set("responseGroup", "small");
  const res = await fetch(url.toString());
  if (!res.ok) return [];
  const data = await res.json();
  return (data.list || []).slice(0, 3).map((item) => ({
    source: "Bangumi",
    title: item.name_cn || item.name || title,
    summary: item.summary || "",
    url: item.id ? `https://bgm.tv/subject/${item.id}` : ""
  }));
}

async function searchBaiduBaike(query, title) {
  for (const word of [query, title]) {
    const res = await fetch(`https://baike.baidu.com/item/${encodeURIComponent(word)}`);
    if (!res.ok) continue;
    const html = await res.text();
    const summary = extractMetaDescription(html) || extractPlainText(html).slice(0, 500);
    const pageTitle = extractTitle(html) || word;
    if (summary) {
      return [{
        source: "百度百科",
        title: pageTitle.replace("_百度百科", ""),
        summary,
        url: res.url
      }];
    }
  }
  return [];
}

async function searchMoegirl(query, title) {
  const url = new URL("https://zh.moegirl.org.cn/api.php");
  url.searchParams.set("action", "query");
  url.searchParams.set("format", "json");
  url.searchParams.set("generator", "search");
  url.searchParams.set("gsrsearch", query || title);
  url.searchParams.set("gsrlimit", "3");
  url.searchParams.set("prop", "extracts");
  url.searchParams.set("exintro", "1");
  url.searchParams.set("explaintext", "1");
  url.searchParams.set("redirects", "1");
  url.searchParams.set("origin", "*");
  const res = await fetch(url.toString());
  if (!res.ok) return [];
  const pages = (await res.json()).query?.pages || {};
  return Object.values(pages).map((page) => ({
    source: "萌娘百科",
    title: page.title || title,
    summary: page.extract || "",
    url: page.title ? `https://zh.moegirl.org.cn/${encodeURIComponent(page.title)}` : ""
  }));
}

function extractMetaDescription(html) {
  const patterns = [
    /<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i,
    /<meta\s+content=["']([^"']+)["']\s+name=["']description["']/i
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return decodeHtml(match[1]);
  }
  return "";
}

function extractTitle(html) {
  const match = html.match(/<title>([\s\S]*?)<\/title>/i);
  return match ? cleanText(decodeHtml(match[1])) : "";
}

function extractPlainText(html) {
  return cleanText(decodeHtml(html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")));
}

function cleanText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function decodeHtml(text) {
  return String(text || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

async function importBilibiliDanmaku(input) {
  const target = parseBilibiliInput(input);
  const page = target.epid
    ? await resolveBangumiEpisode(target.epid)
    : await resolveVideoPage(target);

  if (!page.aid || !page.cid) {
    throw new Error("没有解析到 B 站 aid/cid，可能是链接无效或内容受限");
  }

  const segmentCount = Math.max(1, Math.min(80, Math.ceil((Number(page.duration) || 360) / 360)));
  const comments = [];
  for (let index = 1; index <= segmentCount; index += 1) {
    const url = new URL("https://api.bilibili.com/x/v2/dm/web/seg.so");
    url.searchParams.set("type", "1");
    url.searchParams.set("oid", String(page.cid));
    url.searchParams.set("pid", String(page.aid));
    url.searchParams.set("segment_index", String(index));
    const res = await fetch(url.toString(), {
      credentials: "include"
    });
    if (!res.ok) throw new Error(`B 站弹幕接口请求失败：HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    comments.push(...parseDmSegMobileReply(bytes));
  }

  if (!comments.length) {
    throw new Error("B 站接口返回空弹幕，可能是该集没有弹幕、需要登录、或接口受限");
  }

  comments.sort((a, b) => a.time - b.time);
  return {
    comments,
    meta: {
      title: page.title || "",
      aid: page.aid,
      cid: page.cid,
      source: "bilibili"
    }
  };
}

function parseBilibiliInput(input) {
  const raw = String(input || "").trim();
  if (!raw) throw new Error("请先输入 B 站链接、BV、av 或 ep 号");

  const bv = raw.match(/(?:BV)[0-9A-Za-z]+/)?.[0];
  const av = raw.match(/(?:^|[/?#&\s])av(\d+)/i)?.[1] || raw.match(/^av(\d+)$/i)?.[1];
  const epid = raw.match(/(?:ep_id=|ep)(\d+)/i)?.[1];

  if (epid) return { epid };
  if (bv) return { bvid: bv };
  if (av) return { aid: av };
  throw new Error("无法识别输入，请粘贴 BV、av、ep 或 B 站视频/番剧链接");
}

async function resolveVideoPage(target) {
  const viewUrl = new URL("https://api.bilibili.com/x/web-interface/view");
  if (target.bvid) viewUrl.searchParams.set("bvid", target.bvid);
  if (target.aid) viewUrl.searchParams.set("aid", target.aid);
  const view = await fetchJson(viewUrl.toString());
  if (view.code !== 0 || !view.data) {
    throw new Error(view.message || "B 站视频信息解析失败");
  }
  const page = Array.isArray(view.data.pages) && view.data.pages.length ? view.data.pages[0] : null;
  if (!page) throw new Error("B 站视频分 P 信息解析失败");
  return {
    aid: view.data.aid || target.aid,
    cid: page.cid,
    duration: page.duration,
    title: page.part || view.data.title || ""
  };
}

async function resolveBangumiEpisode(epid) {
  const url = new URL("https://api.bilibili.com/pgc/view/web/season");
  url.searchParams.set("ep_id", String(epid));
  const data = await fetchJson(url.toString());
  if (data.code !== 0 || !data.result) {
    throw new Error(data.message || "B 站番剧信息解析失败");
  }
  const episodes = data.result.episodes || [];
  const episode = episodes.find((item) => String(item.ep_id) === String(epid)) || episodes[0];
  if (!episode) throw new Error("没有找到番剧分集信息");
  return {
    aid: episode.aid,
    cid: episode.cid,
    duration: episode.duration ? Math.ceil(Number(episode.duration) / 1000) : 360,
    title: `${data.result.title || ""} ${episode.title || ""}`.trim()
  };
}

async function fetchJson(url) {
  const res = await fetch(url, {
    credentials: "include"
  });
  if (!res.ok) throw new Error(`B 站接口请求失败：HTTP ${res.status}`);
  return res.json();
}

function parseDmSegMobileReply(bytes) {
  const elems = [];
  const top = readFields(bytes, 0, bytes.length);
  for (const field of top) {
    if (field.no !== 1 || !(field.value instanceof Uint8Array)) continue;
    const elem = parseDanmakuElem(field.value);
    if (elem) elems.push(elem);
  }
  return elems;
}

function parseDanmakuElem(bytes) {
  const fields = readFields(bytes, 0, bytes.length);
  const elem = {};
  for (const field of fields) {
    if (field.no === 2) elem.time = Number(field.value) / 1000;
    if (field.no === 3) elem.mode = field.value === 5 ? "top" : field.value === 4 ? "bottom" : "scroll";
    if (field.no === 4) elem.size = Number(field.value) || undefined;
    if (field.no === 5) elem.color = intToColor(Number(field.value));
    if (field.no === 7) elem.text = textDecode(field.value);
  }
  if (!elem.text || !Number.isFinite(elem.time)) return null;
  return {
    time: elem.time,
    text: elem.text,
    mode: elem.mode || "scroll",
    color: elem.color || "#ffffff",
    size: elem.size,
    source: "bilibili"
  };
}

function readFields(bytes, start, end) {
  const fields = [];
  let offset = start;
  while (offset < end) {
    const key = readVarint(bytes, offset);
    offset = key.offset;
    const no = Number(key.value >> 3n);
    const wire = Number(key.value & 7n);
    if (!no) break;

    if (wire === 0) {
      const value = readVarint(bytes, offset);
      offset = value.offset;
      fields.push({ no, wire, value: Number(value.value) });
    } else if (wire === 2) {
      const len = readVarint(bytes, offset);
      offset = len.offset;
      const next = offset + Number(len.value);
      fields.push({ no, wire, value: bytes.slice(offset, next) });
      offset = next;
    } else if (wire === 5) {
      offset += 4;
    } else if (wire === 1) {
      offset += 8;
    } else {
      break;
    }
  }
  return fields;
}

function readVarint(bytes, offset) {
  let result = 0n;
  let shift = 0n;
  while (offset < bytes.length) {
    const byte = bytes[offset++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: result, offset };
    shift += 7n;
  }
  return { value: result, offset };
}

function textDecode(bytes) {
  return new TextDecoder("utf-8").decode(bytes).trim();
}

function intToColor(value) {
  if (!Number.isFinite(value) || value < 0) return "#ffffff";
  return `#${value.toString(16).padStart(6, "0").slice(-6)}`;
}
