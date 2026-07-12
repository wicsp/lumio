---
name: bilibili-video-summary
description: Summarize B站 (Bilibili) videos by extracting AI-generated subtitles. Handles cookie-based authentication from Dia or Chrome browsers, WBI signing, multi-part videos, and transcript extraction. Use when the user shares a B站 video URL and wants a summary or analysis of its content. Falls back to video download + audio extraction when no subtitles are available.
---

# B站视频总结 (Bilibili Video Summary)

总结B站视频：自动从浏览器提取登录态 → 获取AI字幕 → 拼接文本 → 交给模型总结。

## 前置依赖

Python 环境由 uv 在本 skill 目录内管理，不安装全局 Python 包：

```bash
cd skills/bilibili-video-summary
uv sync
```

可选的 ASR fallback 才需要外部视频/音频工具，例如 `yt-dlp`、`you-get`、`ffmpeg`。不要默认安装这些工具；缺失时告知用户即可。

## 应用场景与工作流程

本 skill 支持三种使用场景：

### 场景 1：直接链接总结

用户直接把 B站链接发来 → 提取字幕 → 总结。最直接的方式，无需额外操作。

### 场景 2：稍后再看作队列

用户在 B站浏览时把感兴趣的视频加入「稍后再看」，回到 pi 里按需处理：

1. **列出稍后再看**：
```bash
uv run python scripts/watch_later.py list -c /tmp/bilibili_cookies.txt
```

2. **与用户确认要总结哪些**：展示列表后，让用户按编号选择（如"总结 3、7、15"）。

3. **逐条获取字幕并总结**：对每个选中的视频调用 `fetch_subtitle.py` → 交给模型总结。

4. **完成后删除**（可选）：
```bash
uv run python scripts/watch_later.py delete 3 -c /tmp/bilibili_cookies.txt
```

### 场景 3：批量总结 + 一键清空

用户要求「把稍后再看全总结然后清空」时：

1. 先 `list` 展示全量，让用户确认
2. 确认后逐条 `fetch_subtitle.py` → 总结（79 个视频约 80+ 次 API 调用，分批处理，中途暂停让用户确认是否继续）
3. 全部完成后 `watch_later.py delete --all --yes`

## 脚本用法

### Step 1: 提取浏览器登录态

从用户浏览器（Dia 或 Chrome）自动解密 B站 cookies：

```bash
cd skills/bilibili-video-summary
uv run python scripts/extract_cookies.py -b dia -o /tmp/bilibili_cookies.txt
```

支持的浏览器：
- `dia`（默认）— Dia 浏览器
- `chrome` — Google Chrome

输出 Netscape 格式 cookie 文件，包含 SESSDATA 等登录凭证。
脚本会强制使用 `0600` 权限；仅把该文件作为当前任务的临时凭证，任务完成后删除。

### Step 2: 获取视频信息和字幕

```bash
uv run python scripts/fetch_subtitle.py <B站链接或BV号> -c /tmp/bilibili_cookies.txt
```

选项：
- `-l ai-zh` — 语言（默认中文AI字幕）
- `-o transcript.txt` — 保存到文件
- `--list-subs` — 仅列出可用字幕，不下载
- `--no-timestamps` — 去掉时间戳，仅保留纯文本

### Step 3: 总结

拿到 transcript 后，读入上下文，让模型总结。如果用户要求"总结这个视频"，直接将 transcript 交给模型并附上总结指令即可。

### Fallback: 无字幕时

当视频没有 AI 字幕时（常见于老视频或未开启字幕功能的视频），走视频下载路径：

```bash
# 方案A：you-get（推荐，能绕过大部分反爬）
you-get --no-caption -o /tmp/ -O bilibili_video "https://www.bilibili.com/video/BVxxxxxx/"

# 方案B：yt-dlp
yt-dlp --cookies-from-browser chrome -f "best[height<=720]" -o "/tmp/bilibili_video.mp4" "https://www.bilibili.com/video/BVxxxxxx/"

# 提取音频
ffmpeg -y -i /tmp/bilibili_video.mp4 -vn -acodec libmp3lame -q:a 5 /tmp/bilibili_audio.mp3

# 交给 Gemini 或其他 ASR 分析
```

### 稍后再看管理

```bash
# 列出稍后再看（有 --json 选项供程序化使用）
uv run python scripts/watch_later.py list -c /tmp/bilibili_cookies.txt

# 按序号删除
uv run python scripts/watch_later.py delete 3 -c /tmp/bilibili_cookies.txt

# 按 BV 号删除
uv run python scripts/watch_later.py delete --bvid BV1sE7h6VESd -c /tmp/bilibili_cookies.txt

# 删除全部（会交互确认，加 --yes 跳过）
uv run python scripts/watch_later.py delete --all -c /tmp/bilibili_cookies.txt
```

## 注意事项

技术实现细节（字幕链路、API 端点、Cookie 解密、WBI 签名）见 `TECHNICAL.md`——排查脚本问题时按需读取。

- **必须登录**：B站 AI 字幕接口在未登录时返回空列表，必须从浏览器提取 SESSDATA
- **登录过期**：如果字幕接口突然返回空，可能是 cookie 过期，重新运行 Step 1
- **Python 环境**：在 `skills/bilibili-video-summary` 下使用 `uv sync` 初始化，之后用 `uv run python ...` 运行脚本
- **BV 号格式**：传给 `--bvid` 的值必须保留 `BV` 前缀，例如 `BV1sE7h6VESd`
- **凭证清理**：总结完成后删除本次生成的 `/tmp/bilibili_cookies.txt`，不要把内容打印到模型上下文或写入仓库
- **yt-dlp B站 412 问题**（2026年7月）：B站更新了 WBI sign 算法，yt-dlp 暂未跟进，建议优先用 you-get 下载视频
- **you-get 不支持字幕提取**：只能用于下载视频本身，字幕仍需通过 API 获取
