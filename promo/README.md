# 自学型熟肉机 · 30 秒介绍片

成片：`自学型熟肉机-30s介绍.mp4`

## 规格

- 1920×1080、30 fps
- H.264 视频、AAC 单声道旁白
- 总时长 30 秒
- 画面包含当前版本真实配置界面与六组矢量动效分镜
- 中文旁白由 macOS 本地语音生成，不上传文本或素材

## 重新生成

需要 macOS、Node.js、FFmpeg、Quick Look 和系统中文语音 `Tingting`。

```bash
zsh promo/render-promo.sh
```

脚本会在 `promo/render/` 生成中间文件，该目录不纳入 Git。
