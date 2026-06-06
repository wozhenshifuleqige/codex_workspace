import json
import os
import re
import tempfile
from typing import Any, Literal
from urllib.parse import quote

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from openai import OpenAI
from pydantic import BaseModel, Field

load_dotenv()

app = FastAPI(title="Quark Danmaku Local AI Server")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class SubtitleSegment(BaseModel):
    start: float
    end: float | None = None
    text: str


class GenerateRequest(BaseModel):
    title: str = ""
    season: int | None = None
    episode: int | None = None
    duration: float | None = None
    style: Literal["anime", "american_drama", "explain", "low_density"] = "anime"
    density: Literal["low", "medium", "high"] = "medium"
    no_spoilers: bool = True
    plot: str = ""
    plot_source: str = ""
    subtitles: list[SubtitleSegment] = Field(default_factory=list)


class SearchPlotRequest(BaseModel):
    title: str
    season: int | None = None
    episode: int | None = None
    category: str = "anime"


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "model": os.getenv("OPENAI_MODEL", ""),
        "base_url": os.getenv("OPENAI_BASE_URL", ""),
    }


@app.post("/search-plot-cn")
async def search_plot_cn(payload: SearchPlotRequest) -> dict[str, Any]:
    query = build_cn_query(payload)
    candidates: list[dict[str, str]] = []
    async with httpx.AsyncClient(timeout=4.0, follow_redirects=True) as client:
        for loader in (search_bangumi, search_baidu_baike, search_moegirl):
            try:
                candidates.extend(await loader(client, query, payload))
            except Exception:
                continue

    deduped: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in candidates:
        summary = clean_summary(item.get("summary", ""))
        if len(summary) < 20:
            continue
        key = f"{item.get('source')}:{item.get('title')}:{summary[:40]}"
        if key in seen:
            continue
        seen.add(key)
        item["summary"] = summary[:900]
        deduped.append(item)

    return {"query": query, "candidates": deduped[:5]}


@app.post("/generate-danmaku")
def generate_danmaku(payload: GenerateRequest) -> dict[str, Any]:
    if not payload.subtitles and not payload.plot.strip():
        raise HTTPException(status_code=400, detail="subtitles or plot is required")

    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY is not configured")

    client = OpenAI(
        api_key=api_key,
        base_url=os.getenv("OPENAI_BASE_URL") or None,
    )
    model = os.getenv("OPENAI_MODEL", "gpt-4o-mini")

    comments: list[dict[str, Any]] = []
    if payload.subtitles:
        chunks = chunk_subtitles(payload.subtitles, max_items=80)
        for index, chunk in enumerate(chunks):
            comments.extend(generate_chunk(client, model, payload, chunk, index))
    else:
        comments.extend(generate_from_plot(client, model, payload))

    comments = normalize_comments(comments, payload.duration)
    return {"comments": comments}


@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...)) -> dict[str, Any]:
    try:
        from faster_whisper import WhisperModel
    except Exception as exc:
        raise HTTPException(
            status_code=501,
            detail="faster-whisper is not installed. Install it manually to enable transcription.",
        ) from exc

    suffix = os.path.splitext(file.filename or "")[1] or ".media"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(await file.read())
        path = tmp.name

    try:
        model_name = os.getenv("WHISPER_MODEL", "small")
        model = WhisperModel(model_name, device="auto", compute_type="auto")
        segments, _info = model.transcribe(path, vad_filter=True)
        return {
            "segments": [
                {"start": float(seg.start), "end": float(seg.end), "text": seg.text.strip()}
                for seg in segments
                if seg.text and seg.text.strip()
            ]
        }
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


def build_cn_query(payload: SearchPlotRequest) -> str:
    parts = [payload.title.strip()]
    if payload.season:
        parts.append(f"第{payload.season}季")
    if payload.episode:
        parts.append(f"第{payload.episode}集")
    parts.append("剧情 简介")
    return " ".join(part for part in parts if part)


async def search_bangumi(
    client: httpx.AsyncClient, query: str, payload: SearchPlotRequest
) -> list[dict[str, str]]:
    url = f"https://api.bgm.tv/search/subject/{quote(payload.title)}"
    res = await client.get(url, params={"type": 2, "responseGroup": "small"})
    if res.status_code >= 400:
        return []
    data = res.json()
    items = data.get("list") or []
    output: list[dict[str, str]] = []
    for item in items[:3]:
        summary = item.get("summary") or ""
        title = item.get("name_cn") or item.get("name") or payload.title
        if summary:
            output.append(
                {
                    "source": "Bangumi",
                    "title": str(title),
                    "summary": str(summary),
                    "url": f"https://bgm.tv/subject/{item.get('id')}" if item.get("id") else "",
                }
            )
    return output


async def search_baidu_baike(
    client: httpx.AsyncClient, query: str, payload: SearchPlotRequest
) -> list[dict[str, str]]:
    title = payload.title.strip()
    candidates = [query, title]
    output: list[dict[str, str]] = []
    for word in candidates:
        url = f"https://baike.baidu.com/item/{quote(word)}"
        res = await client.get(
            url,
            headers={
                "User-Agent": "Mozilla/5.0",
                "Accept-Language": "zh-CN,zh;q=0.9",
            },
        )
        if res.status_code >= 400:
            continue
        html = res.text
        summary = extract_meta_description(html) or extract_first_paragraph(html)
        page_title = extract_html_title(html) or word
        if summary:
            output.append(
                {
                    "source": "百度百科",
                    "title": page_title,
                    "summary": summary,
                    "url": str(res.url),
                }
            )
            break
    return output


async def search_moegirl(
    client: httpx.AsyncClient, query: str, payload: SearchPlotRequest
) -> list[dict[str, str]]:
    params = {
        "action": "query",
        "format": "json",
        "generator": "search",
        "gsrsearch": payload.title,
        "gsrlimit": "3",
        "prop": "extracts",
        "exintro": "1",
        "explaintext": "1",
        "redirects": "1",
        "origin": "*",
    }
    res = await client.get("https://zh.moegirl.org.cn/api.php", params=params)
    if res.status_code >= 400:
        return []
    pages = (res.json().get("query") or {}).get("pages") or {}
    output: list[dict[str, str]] = []
    for page in pages.values():
        summary = page.get("extract") or ""
        title = page.get("title") or payload.title
        if summary:
            output.append(
                {
                    "source": "萌娘百科",
                    "title": str(title),
                    "summary": str(summary),
                    "url": f"https://zh.moegirl.org.cn/{quote(str(title))}",
                }
            )
    return output


def extract_meta_description(html: str) -> str:
    patterns = [
        r'<meta\s+name=["\']description["\']\s+content=["\']([^"\']+)["\']',
        r'<meta\s+content=["\']([^"\']+)["\']\s+name=["\']description["\']',
    ]
    for pattern in patterns:
        match = re.search(pattern, html, flags=re.I)
        if match:
            return html_unescape(match.group(1))
    return ""


def extract_html_title(html: str) -> str:
    match = re.search(r"<title>(.*?)</title>", html, flags=re.I | re.S)
    if not match:
        return ""
    return clean_summary(match.group(1)).replace("_百度百科", "").strip()


def extract_first_paragraph(html: str) -> str:
    text = re.sub(r"<script[\s\S]*?</script>", "", html, flags=re.I)
    text = re.sub(r"<style[\s\S]*?</style>", "", text, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    return clean_summary(html_unescape(text))[:500]


def html_unescape(text: str) -> str:
    return (
        text.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&quot;", '"')
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
    )


def clean_summary(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def chunk_subtitles(items: list[SubtitleSegment], max_items: int) -> list[list[SubtitleSegment]]:
    return [items[i : i + max_items] for i in range(0, len(items), max_items)]


def generate_chunk(
    client: OpenAI,
    model: str,
    payload: GenerateRequest,
    subtitles: list[SubtitleSegment],
    chunk_index: int,
) -> list[dict[str, Any]]:
    style_map = {
        "anime": "动漫吐槽风格，轻松、短句、适度玩梗",
        "american_drama": "美剧轻弹幕风格，低密度、偏剧情反应",
        "explain": "剧情解释风格，帮助理解人物动机和关系",
        "low_density": "低密度陪看风格，只在关键处给短反应",
    }
    density_map = {"low": "每 60 秒 1-3 条", "medium": "每 60 秒 3-6 条", "high": "每 60 秒 6-10 条"}
    subtitle_text = "\n".join(
        f"[{seg.start:.2f}-{(seg.end or seg.start + 3):.2f}] {seg.text}" for seg in subtitles
    )
    system = (
        "你是弹幕生成器。只输出 JSON 数组，不要输出解释。"
        "每项必须包含 time 和 text，可选 color/mode。"
        "time 使用秒，text 使用中文短句。"
        "只基于给定字幕当前片段生成，不要剧透后续剧情。"
    )
    user = {
        "title": payload.title,
        "season": payload.season,
        "episode": payload.episode,
        "style": style_map[payload.style],
        "density": density_map[payload.density],
        "no_spoilers": payload.no_spoilers,
        "chunk_index": chunk_index,
        "subtitles": subtitle_text,
    }
    response = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": json.dumps(user, ensure_ascii=False)},
        ],
        temperature=0.8,
    )
    content = response.choices[0].message.content or "[]"
    return parse_json_array(content)


def generate_from_plot(client: OpenAI, model: str, payload: GenerateRequest) -> list[dict[str, Any]]:
    style_map = {
        "anime": "动漫吐槽风格，轻松、短句、适度玩梗",
        "american_drama": "美剧轻弹幕风格，低密度、偏剧情反应",
        "explain": "剧情解释风格，帮助理解人物动机和关系",
        "low_density": "低密度陪看风格，只在关键处给短反应",
    }
    density_map = {"low": 24, "medium": 48, "high": 80}
    duration = float(payload.duration or 1440)
    target_count = density_map[payload.density]
    system = (
        "你是 AI 陪看弹幕生成器。只输出 JSON 数组，不要输出解释。"
        "每项必须包含 time 和 text，可选 color/mode。"
        "time 使用秒，必须在 0 到 duration 内。"
        "text 使用中文短句，不要超过 24 个字。"
        "只能基于给定剧情摘要生成，不要编造具体台词，不要假装是真实观众弹幕。"
    )
    user = {
        "title": payload.title,
        "season": payload.season,
        "episode": payload.episode,
        "duration": duration,
        "target_count": target_count,
        "style": style_map[payload.style],
        "plot_source": payload.plot_source,
        "plot": payload.plot[:1800],
        "time_strategy": "如果剧情没有分段时间，按开场、推进、高潮、收束均匀分布；不要集中在同一分钟。",
        "no_spoilers": payload.no_spoilers,
    }
    response = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": json.dumps(user, ensure_ascii=False)},
        ],
        temperature=0.85,
    )
    content = response.choices[0].message.content or "[]"
    return parse_json_array(content)


def parse_json_array(text: str) -> list[dict[str, Any]]:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        cleaned = cleaned.removeprefix("json").strip()
    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=502, detail=f"LLM returned invalid JSON: {exc}") from exc
    if not isinstance(data, list):
        raise HTTPException(status_code=502, detail="LLM output must be a JSON array")
    return [item for item in data if isinstance(item, dict)]


def normalize_comments(comments: list[dict[str, Any]], duration: float | None) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for item in comments:
        try:
            time = float(item.get("time", item.get("t")))
        except (TypeError, ValueError):
            continue
        text = str(item.get("text", item.get("content", ""))).strip()
        if not text:
            continue
        if duration and time > duration:
            continue
        output.append(
            {
                "time": max(0, time),
                "text": text[:40],
                "mode": item.get("mode", "scroll"),
                "color": item.get("color", "#ffffff"),
                "source": "ai",
            }
        )
    output.sort(key=lambda item: item["time"])
    return output
