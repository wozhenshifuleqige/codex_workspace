# Local AI Server

本地 AI 弹幕生成服务，供浏览器插件调用。

## 启动

```powershell
cd D:\codex_workspace\quark-danmaku-extension\local-ai-server
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env
```

编辑 `.env`：

```text
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=你的 API Key
OPENAI_MODEL=gpt-4o-mini
```

启动服务：

```powershell
uvicorn server:app --host 127.0.0.1 --port 8765
```

## 音频识别

`/transcribe` 会尝试使用 `faster-whisper`。如果需要这个能力，额外安装：

```powershell
pip install faster-whisper
```

第一版不会直接读取夸克网盘视频流，需要你在插件中选择本地视频或音频文件上传给本地服务识别。

## 国内剧情搜索

插件点击“国内搜索剧情”会调用：

```text
POST /search-plot-cn
```

服务会按顺序尝试：

- Bangumi API
- 百度百科公开词条摘要
- 萌娘百科 MediaWiki API

搜索结果只返回短摘要。确认或编辑摘要后，插件会调用 `/generate-danmaku` 生成 AI 陪看弹幕。该模式不需要字幕，但剧情越短，弹幕越泛。

实现边界：

- 不抓取字幕、台词、完整剧本或付费内容。
- 不绕过登录、验证码、反爬或会员限制。
- 百度百科失败时会降级到其他来源。
