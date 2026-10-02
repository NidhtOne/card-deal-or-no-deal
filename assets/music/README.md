# assets/music —— BGM 曲目目录（docs/开发文档.md 3.9）

开源用户可直接替换本目录内的音频文件（同名替换）或增删曲目：

- **同名替换**：保持文件名不变，替换为任意浏览器可播放的音频文件（mp3/ogg/wav 均可），无需改代码。
- **增删曲目**：增删后 `availableTracks` 白名单自动跟随（服务端扫描本目录生成，见
  `server/src/upload/asset-catalog.service.ts`），设置页「背景音乐曲目」下拉即出现新曲目。
  注意：删除 `loading.wav` / `match.wav` / `finale.wav` 会导致加载页 / 对局页 / 结算页氛围曲
  回退到用户所选 `bgm_track` 播放（代码里做了兜底映射，不报错）。
- 隐藏文件（`.` 开头）与子目录不参与曲目扫描。

## 内置曲目与页面氛围映射

曲目命名只影响下拉展示名，页面氛围映射按**固定文件名**匹配（前端钦定口径，文档 3.9 未细化，
代码注释标注「文档外补充」，见 `web/src/audio/AudioManager.ts`）：

| 文件名 | 用途 |
| --- | --- |
| `lobby.wav` | 大厅默认曲（bgm_track 默认值即本曲） |
| `loading.wav` | 加载页紧张氛围曲（`/match/load`） |
| `match.wav` | 对局页曲（`/match/play`） |
| `finale.wav` | 结算页曲（`/match/result`） |

当前文件均为 8kHz 单声道占位音（开发期占位），可整批替换为正式曲目。

## sfx/ 子目录 —— 音效占位【文档外补充】

开发文档 3.9 仅定义音乐功能，未定义音效事件清单。以下 6 个音效事件为文档外补充
（`web/src/audio/AudioManager.ts` 注释同步标注）。子目录不参与 BGM 曲目白名单扫描。

| 文件名 | 事件 |
| --- | --- |
| `flip.wav` | 翻牌 |
| `offer.wav` | 报价出现 |
| `deal.wav` | 成交 |
| `nodeal.wav` | 拒绝 |
| `reveal.wav` | 开牌（终局换牌揭晓） |
| `settle.wav` | 结算 |
