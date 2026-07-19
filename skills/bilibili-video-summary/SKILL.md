---
name: bilibili-video-summary
description: Summarize B站 (Bilibili) videos with a subtitle-first pipeline and bounded local whisper.cpp ASR fallback. Handles optional Dia/Chrome cookies, WBI signing, provenance, and private temporary media. Use when the user shares a B站 video URL and wants a summary or analysis of its content.
---

# B站视频总结 (Bilibili Video Summary)

总结B站视频：尝试浏览器登录态（失败时匿名继续）→ 优先获取平台字幕 → 无字幕时下载音频并用本地 whisper.cpp 转写 → 交给模型总结。

## 前置依赖

Python 环境由 uv 在本 skill 目录内管理，不安装全局 Python 包：

```bash
cd skills/bilibili-video-summary
uv sync
```

Atlas 的 `bilibili-summary-v4` ASR fallback 需要 `yt-dlp`、`ffmpeg`、`whisper-cli` 和 multilingual `small` 模型。它们由 macsp 的 `nix-config` 声明；模型是可重建缓存，不进入 Git。若模型不存在，运行：

```bash
mkdir -p "$HOME/Library/Caches/Lumio/asr/whisper"
whisper-cpp-download-ggml-model small "$HOME/Library/Caches/Lumio/asr/whisper"
```

## 应用场景与工作流程

本 skill 支持四种使用场景：

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

### 场景 4：Atlas 收藏夹自动队列

`Atlas` 收藏夹是无人值守采集队列，不需要模型判断视频是否属于知识类：用户把希望处理的视频明确收藏到这里即可。

```bash
# 只读列出队列
uv run python scripts/atlas_queue.py list -c /tmp/bilibili_cookies.txt --json

# 仅在 Atlas 已确认 summary Resource 发布成功后，清理单个视频
uv run python scripts/atlas_queue.py cleanup -c /tmp/bilibili_cookies.txt --bvid BV1sE7h6VESd
```

`cleanup` 会分别从 `Atlas` 收藏夹和「稍后再看」移除该视频；某一处已经不存在时仍视为成功。脚本没有批量清空命令。总结、Resource 发布或验证失败时不得调用清理。

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

`bilibili-summary-v4` 自动执行以下受限流程，不需要手动拼接 shell 命令：

```bash
yt-dlp bestaudio -> ffmpeg PCM s16le/16kHz/mono -> whisper.cpp JSON -> transcript Resource
```

- 默认最长 7200 秒，可用 `BILIBILI_ASR_MAX_DURATION_SECONDS` 收紧。
- 多 P 视频在没有平台字幕时会明确失败，避免只处理第一 P 却产生误导性摘要。
- 下载的音频、WAV 和 whisper JSON 只保存在任务临时目录，成功、失败或取消后都会清理。
- Atlas 只记录转写来源、语言、引擎/模型和外部 transcript ArtifactRef，不保存原始媒体。

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

### Atlas 收藏夹队列

```bash
# 精确查找名为 Atlas 的收藏夹，并列出所有分页内容
uv run python scripts/atlas_queue.py list -c /tmp/bilibili_cookies.txt --json

# 成功发布后，幂等清理一个 BV 号（Atlas 收藏夹 + 稍后再看）
uv run python scripts/atlas_queue.py cleanup -c /tmp/bilibili_cookies.txt --bvid BV1sE7h6VESd
```

收藏夹名称必须精确且唯一。自动化只允许逐条清理，不调用 `watch_later.py delete --all`。

## 注意事项

技术实现细节（字幕链路、API 端点、Cookie 解密、WBI 签名）见 `TECHNICAL.md`——排查脚本问题时按需读取。

- **Cookie 是增强而非硬依赖**：登录态可提高字幕和受限媒体的可用性；公共视频会在提取失败时匿名继续。
- **登录过期**：如果原本可见的字幕突然回退到 ASR，可重新运行 Step 1 排查 cookie。
- **Python 环境**：在 `skills/bilibili-video-summary` 下使用 `uv sync` 初始化，之后用 `uv run python ...` 运行脚本
- **BV 号格式**：传给 `--bvid` 的值必须保留 `BV` 前缀，例如 `BV1sE7h6VESd`
- **凭证清理**：总结完成后删除本次生成的 `/tmp/bilibili_cookies.txt`，不要把内容打印到模型上下文或写入仓库
- **资源边界**：字幕和 ASR 结果都是机器生成的 Resource，不会自动成为 Knowledge Comment。
