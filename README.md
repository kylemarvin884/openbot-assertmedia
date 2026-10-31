# assertmedia

**在 agent 生成的图片、音频、视频进 CI 之前，断言它不是黑屏、静音或 0.2 秒的空文件。**

零运行时依赖，Node 22+，确定性判断，退出码直接进 CI。不调模型，不上传文件。

```bash
git clone https://github.com/kylemarvin884/openbot-assertmedia
cd openbot-assertmedia
node src/cli.mjs check fixtures/chart.png fixtures/tone.wav fixtures/clip-black.mp4 --spec examples/demo.spec.json
```

真实输出（上面这条命令，2026-11-01，本机 Node 24.19）：

```text
assertmedia 0.1.0  spec examples/demo.spec.json  [image, audio, video]

fixtures/chart.png  image 320x180 png, pixels png-native
  ok    image.minWidth   320   (expect >= 300)
  ok    image.minHeight  180   (expect >= 160)
  ok    image.aspect     1.778 (320x180)   (expect 1.778 +-2.0%)
  ok    image.blank      stdDev 39.63, 0.6% one colour   (expect image has visible content)

fixtures/tone.wav  audio 2s pcm 44100Hz 1ch
  ok    audio.minDuration  2s   (expect >= 1s)
  ok    audio.sampleRate   44100 Hz   (expect = 44100 Hz)
  ok    audio.audible      -11 dBFS   (expect > -60 dBFS RMS)

fixtures/clip-black.mp4  video 1.5s 320x180 h264, no audio
  ok    video.minDuration  1.5s   (expect >= 1s)
  ok    video.maxDuration  1.5s   (expect <= 3s)
  ok    video.width        320   (expect = 320)
  ok    video.height       180   (expect = 180)
  ok    video.codec        h264   (expect h264)
  FAIL  video.blankFrames  2/2 sampled frames blank   (expect not every frame is blank)
  skip  spec.audio         video has no audio track to measure

3 files: 12 ok, 1 failed, 1 skipped -> exit 1
skipped checks were not verified; pass --strict to turn them into failures
```

## 为什么需要它

生成侧已经自动化了，验收侧还停在人眼：

- [`alchaincyf/huashu-motion`](https://github.com/alchaincyf/huashu-motion)（1,934★，2026-11-01 查）让 agent 一键出宣传片，卖点是「**能指着画面改**」——人要逐帧看，因为 CI 不知道这帧有没有内容。
- [`Leonxlnx/earshot`](https://github.com/Leonxlnx/earshot)（3,365★，2026-11-01 查）专门给 coding agent 造「耳朵」，说明音频产物的审查是独立环节。
- [`EL4CTEO/blender-skills`](https://github.com/EL4CTEO/blender-skills)（619★，2026-11-01 查）把 QA 写成给 agent 的指令，而不是可执行的断言。

这些失败方式高度重复，而且全是客观的：

| 现象 | 根因 |
| --- | --- |
| 图表看着是空白 | matplotlib 拿到空数据，渲染成功但没内容 |
| 截图是白屏 | Playwright 在 hydration 之前截的 |
| 音频文件 2 秒，全静音 | TTS 调用成功但返回空音频 |
| 视频只有前 0.5 秒 | ffmpeg 参数错，`-shortest` 剪掉了 |
| 视频全黑 | 渲染管线失败，编码器照样输出 |

`ffprobe` 会告诉你这些文件的时长和编码，但不会告诉你「它是不是空的」，也不会给你退出码。Lighthouse CI 和截图 golden 比对的是「和上次一样」——黑屏对黑屏照样通过。`assertmedia` 把判断写成 spec，用确定性阈值回答「这里面有东西吗」。

## 安装

没有依赖，没有构建步骤：

```bash
git clone https://github.com/kylemarvin884/openbot-assertmedia
cd openbot-assertmedia
npm test          # 38 个测试，含真实 h264 / WAV / PNG fixture
node demo/demo.mjs  # 生成一批媒体，跑一次通过、一次失败
```

想全局用：`npm link`，然后 `assertmedia check ...`。

需要 Node 22 以上。ffmpeg 是**可选**的，见下面「能测什么」。

## 三种用法

### 1. 写 spec，跑 check

```json
{
  "version": 1,
  "file": { "minBytes": 2048 },
  "image": { "minWidth": 1200, "minHeight": 630, "maxUniformRatio": 0.98 },
  "video": {
    "minDuration": 6,
    "maxDuration": 15,
    "maxWidth": 4096,
    "codec": ["h264", "hevc"],
    "requireAudio": true,
    "maxBlankRatio": 0.2
  },
  "audio": { "minDuration": 6, "sampleRate": 48000, "channels": 2, "minRmsDbfs": -45 }
}
```

```bash
assertmedia check out/ --spec media.spec.json --report report.md
assertmedia check out/launch.mp4 --spec media.spec.json --json
assertmedia check out/ --spec media.spec.json --strict   # skip 也算失败
```

`out/` 是目录时只扫支持的媒体扩展名，加 `--recursive` 递归。

### 2. 从一个已有产物反推 spec

```bash
assertmedia init out/launch.mp4 > media.spec.json
```

它记录的是「这个文件现在是什么」，不是「应该是什么」。跑通后请手动收紧数字再进 CI。

### 3. 先看能测到什么

```bash
assertmedia probe out/launch.mp4
```

```text
out/launch.mp4  video  video 8.4s 1920x1080 h264, audio aac
  format mp4, 4211332 bytes
  audio: aac 48000Hz 2ch, level measured
  frames: sampled 9, blank 0 (64x64)
  not measured: nothing
```

`probe` 会把「没测到的东西」列出来，而不是让你以为都测了。

## 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 所有请求的检查都通过 |
| 1 | 有检查失败；或用了 `--strict` 且有检查没被验证 |
| 2 | 用法错误、文件读不了、spec 不合法 |

spec 里写错一个键（比如 `minWidht`）会直接 exit 2 并指出键名，不会静默忽略。这条比什么都重要——静默忽略拼写错误等于给你一个假绿灯。

## 能测什么，不能测什么

| 格式 | 原生解析（不需要任何外部程序） | 需要 ffmpeg / ffprobe |
| --- | --- | --- |
| PNG | 全解码：尺寸、色数、众数色占比、亮度标准差、透明比例、空图判定 | — |
| JPEG / WebP / GIF | 尺寸 | 像素统计（缩放到 64×64 采样） |
| WAV (PCM) | 时长、采样率、声道、峰值、RMS、100ms 窗口静音占比 | — |
| MP4 / MOV | box 解析：时长、分辨率、codec、是否有音轨 | 抽帧（1fps，64×64）判空帧；音轨电平 |
| MP3 / AAC / FLAC / M4A | — | 元数据 + 电平 |
| WebM / MKV | — | 元数据 |

**没有 ffmpeg 时，这件事不会被假装成通过。** 相关检查显示为 `skip`，退出码仍是 0；如果你要的是「没验证就不许发布」，加 `--strict`。

抽帧是 1fps、缩到 64×64 再做统计，只回答「画面里有没有东西」。它不判断好不好看，也不做帧级精确比对——那是另一个工具的事。

## CI

```yaml
name: media-assertions
on: [pull_request]
jobs:
  media:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Install ffmpeg (optional, only for frame sampling)
        run: sudo apt-get update && sudo apt-get install -y ffmpeg
      - run: node vendor/assertmedia/src/cli.mjs check out/ --spec media.spec.json --strict
```

`--strict` 意味着 ffmpeg 装失败也会让构建红，这通常是你要的效果。

## 三个真实用例

1. **Launch 视频**：agent 生成 6–15 秒宣传片，断言时长、有音轨、不是全黑。全黑通常意味着渲染失败了但编码器照常输出。
2. **图表 / 截图**：agent 用 matplotlib 或 Playwright 出图，断言最小尺寸、不是纯色、透明比例不为 1。空数据画出来的图和正常图在元数据上完全一样。
3. **TTS / 配音片段**：断言时长、采样率、RMS 不低于 -45 dBFS、静音窗口占比不超过 20%。

## spec 参考

| 组 | 键 |
| --- | --- |
| `file` | `minBytes`, `maxBytes` |
| `image` | `width`, `height`, `minWidth`, `maxWidth`, `minHeight`, `maxHeight`, `aspect`（`"16:9"`）, `aspectTolerance`（默认 0.02）, `minColors`, `maxUniformRatio`, `minStdDev`, `maxTransparentRatio`, `allowBlank` |
| `audio` | `duration`, `minDuration`, `maxDuration`, `sampleRate`, `channels`, `minRmsDbfs`, `maxPeakDbfs`, `maxSilenceRatio`, `requireAudible` |
| `video` | `duration`, `minDuration`, `maxDuration`, `width`, `height`, `minWidth`, `maxWidth`, `minHeight`, `maxHeight`, `codec`（字符串或数组）, `requireAudio`, `maxBlankRatio` |

两个默认值值得知道：

- spec 里有 `image` 规则时，**默认要求图不是空的**（`allowBlank: false`）。
- spec 里有 `audio` 规则时，**默认要求声音不是静音**（`requireAudible: true`，判据 RMS > -60 dBFS）。

要关掉就显式写 `"allowBlank": true` / `"requireAudible": false`。空图判定会同时打印 `stdDev` 和众数色占比，误报时你能直接看到是哪条阈值触发的。

## 设计取舍

- **不调模型**：同一批字节永远同一结论，不花钱，能在 CI 里当 gate。主观质量（好不好看、像不像人声）不在范围内。
- **SKIP 是一等公民**：测不了就说测不了。任何「默认通过」的设计都会在某天变成线上事故。
- **原生优先**：PNG / WAV / MP4 的解析都在仓库里，38 个测试没有任何网络调用；ffmpeg 只在它确实更好的地方（抽帧、电平）被可选调用。
- **阈值是静态的**：`stdDev < 1.5` 之类的默认值来自「接近纯色」的常识，不是从数据集里学的。误报就调 spec，不用改代码。

## 开发

```bash
npm test                 # node --test
npm run fixtures         # 重新生成 fixtures/（MP4 需要 ffmpeg）
npm run demo             # 通过 + 失败两个场景
```

`src/fixtures.mjs` 可以当库用，`draw` 出一批确定性媒体来测自己的管线。

## 已验证 / 未验证

- 已验证：38 个测试全绿；真实的 ffmpeg h264 MP4（含/不含音轨）、WAV、PNG（真彩 / 调色板 / 全透明）都能正确解析；空图、静音、全黑视频都会 exit 1。
- 未验证：没有真实用户使用数据，没有 star / 下载量可以引用；JPEG 的像素统计只在本机 ffmpeg 9.0.1 下测过。

## License

MIT
