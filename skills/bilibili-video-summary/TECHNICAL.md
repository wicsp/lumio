# B站视频总结 — 技术参考

> 此文件包含实现细节，仅在排查脚本问题或需要理解底层机制时阅读。
> 日常使用时不需要，因此从 SKILL.md 中分离以保持 agent 上下文的精简。

## 字幕获取链路

```
BV号 → pagelist (获取cid) → x/player/wbi/v2 (WBI签名+登录态)
    → subtitle.subtitles[].subtitle_url → 下载JSON → body[].content 拼接
```

## 稍后再看 API

```
GET  x/v2/history/toview       → 获取列表 (count + list[])
POST x/v2/history/toview/del   → 删除 (ids + csrf)
```

POST 需要 CSRF token，从 cookie 中的 `bili_jct` 字段获取。

## Cookie 解密 (macOS)

1. Keychain: `security find-generic-password -w -a 'Dia' -s 'Dia Safe Storage'`
2. Key derivation: `PBKDF2(password, b'saltysalt', 16, 1003)` → AES-128 key
3. Decrypt: AES-CBC (IV = 16 spaces), strip v10 prefix, unpad PKCS7, strip 32-byte SHA256 prefix

## WBI 签名

B站 API 需要 WBI 签名：从 nav 接口获取 `img_key` + `sub_key` → mixin 表取前 32 字符拼接 → `md5(sorted_params + mixin_key)`。
