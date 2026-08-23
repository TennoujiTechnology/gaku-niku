# 操作界面逻辑宣传片

成片不再纳入源码仓库，可从 [GakuNiku v0.2.3 Release](https://github.com/TennoujiTechnology/gaku-niku/releases/tag/v0.2.3) 下载 `自学型熟肉机-操作界面逻辑宣传片.mp4`，并使用同一 Release 中的 `PROMO_SHA256SUMS.txt` 校验。

本片沿着真实界面状态流介绍准备、翻译、精修和导出逻辑，并内嵌中文旁白字幕。

## 重新生成

需要 macOS、Node.js、FFmpeg、Quick Look 和系统中文语音 `Tingting`。

```bash
zsh promo/ui-guide/render.sh
```

中间文件写入 `promo/ui-guide/render/`，不纳入 Git。
