# MCP Music Studio

[English](https://github.com/linxule/mcp-music-studio/blob/main/README.md) · **简体中文** · [Français](https://github.com/linxule/mcp-music-studio/blob/main/README.fr.md) · [日本語](https://github.com/linxule/mcp-music-studio/blob/main/README.ja.md)

[![npm](https://img.shields.io/npm/v/mcp-music-studio)](https://www.npmjs.com/package/mcp-music-studio) [![CI](https://github.com/linxule/mcp-music-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/linxule/mcp-music-studio/actions/workflows/ci.yml) [![License: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](https://github.com/linxule/mcp-music-studio/blob/main/LICENSE)

在聊天里和 AI 助手一起做音乐。想要一首歌，就得到一份可以播放、可以编辑的乐谱；想要一段节拍，就得到一个带视觉效果的现场编程播放器。之后可以一起修改作品、在播放中调节它的控件，或者和 AI 轮流演奏。

Music Studio 是一个 MCP 服务器。MCP 是给 AI 助手添加额外工具的标准方式，你需要一个支持它的聊天应用，比如 Claude。在 Claude、claude.ai 和其他支持 MCP Apps 的应用里，播放器会直接出现在对话中；在 Claude Code 等终端应用里，你会得到一个链接，在浏览器里打开播放器。

<a href="https://github.com/linxule/mcp-music-studio/releases/download/v0.5.3/mcp-music-studio-v0.5-live-set-1080p60.mp4"><img src="https://raw.githubusercontent.com/linxule/mcp-music-studio/main/assets/live-set-stage.gif" alt="一段 Strudel 乐句（pattern）的钢琴卷帘被送入 Hydra 着色器，随后 Stage 模式占满整个画面" width="720"></a>

*播放器里的一场现场演出。每个段落都是在音乐播放中做出的修改。[观看完整视频](https://github.com/linxule/mcp-music-studio/releases/download/v0.5.3/mcp-music-studio-v0.5-live-set-1080p60.mp4)。*

## 快速开始

把这个 URL 添加为远程 MCP 服务器，无需安装任何东西。

```
https://music-studio.linxule.com/mcp
```

- **Claude 和 claude.ai：** 打开设置，进入 Connectors，添加一个自定义连接器，粘贴这个 URL。
- **Claude Code：** 运行 `claude mcp add --transport http music-studio https://music-studio.linxule.com/mcp`

然后直接开口要一首歌、一段节拍或一支音乐视频。无需注册账号。浏览器可能会先拦住声音，在播放器里点一次 Play 即可。

## 你可以做什么

- **乐谱。** 用 ABC 记谱法写谱，渲染成五线谱，可以用 128 种 General MIDI 乐器中的任意一种播放。加上风格（摇滚、爵士、巴萨诺瓦等）就有鼓、贝斯和和弦伴奏。可以直接在播放器里编辑乐谱、移调，并下载 WAV 或 MIDI。[乐谱详细介绍](https://github.com/linxule/mcp-music-studio/blob/main/docs/sheet-music.md)（英文）
- **现场编程。** 用 [Strudel](https://strudel.cc)（TidalCycles 的 JavaScript 版本）编写模式，编辑器可以边播放边改：鼓机、合成器、效果器、钢琴卷帘，以及跟随音乐的 Hydra 着色器视觉。[现场编程详细介绍](https://github.com/linxule/mcp-music-studio/blob/main/docs/live-coding.md)（英文）
- **音乐视频和舞台作品。** 模式代码可以画画、对每个音符做出反应、响应点按，还能跟着音乐的节奏念出台词。指南的 gallery 里有一部短片、一段念白二重奏，还有一个会作曲的“生命游戏”。
- **一起演奏。** 实时会话（live session）会让同一个播放器一直开着。AI 会读取你刚才的操作，把它的回应放到同一个播放器里，从下一小节开始。推子、打击垫和手机的动作都能变成控制器。[一起演奏详细介绍](https://github.com/linxule/mcp-music-studio/blob/main/docs/playing-together.md)（英文）
- **分享。** 当乐谱或模式小到能装进一个链接时，回复里会附上打开完整播放器的链接。更大的作品可以要求生成托管链接，有效期 30 天。

## 工具

| 工具 | 功能 |
|------|--------------|
| `play-sheet-music` | 绘制并播放用 ABC 记谱法写成的乐谱 |
| `play-live-pattern` | 为 Strudel 代码打开现场编程播放器，也可以作为实时会话 |
| `get-session` | 读取实时会话里发生的事，或者等待聆听者按下 Pass |
| `update-session` | 在下一小节或乐句处，把新代码换进实时会话的播放器 |
| `get-music-guide` | ABC 记谱法参考：语法、乐器、风格、流派 |
| `get-strudel-guide` | Strudel 参考：音色、效果、视觉、舞台、gallery 作品 |
| `search-music-docs` | 搜索 Strudel 和 abcjs 的文档 |
| `analyze-harmony` | 识别和弦名称、判断调性、构建和弦进行 |
| `convert-abc-to-strudel` | 把写好的旋律变成 Strudel 模式 |
| `create-share-link` | 把作品托管 30 天，返回一个任何人都能打开的链接 |

参数、提示词和播放器自带的工具：[工具与提示词](https://github.com/linxule/mcp-music-studio/blob/main/docs/tools.md)（英文）。

## 在自己的电脑上运行

托管的 URL 无需任何配置。如果想在本地运行服务器，可以用 npm：

```bash
claude mcp add music-studio -- npx -y mcp-music-studio --stdio
```

Claude Desktop、Codex、Gemini CLI、VS Code、Cursor、Windsurf 等客户端的配置方法，以及渲染模式和 HTTP 模式：[安装与客户端配置](https://github.com/linxule/mcp-music-studio/blob/main/docs/install.md)（英文）。

## 更多

- [更新日志](https://github.com/linxule/mcp-music-studio/blob/main/CHANGELOG.md)（英文）
- [开发](https://github.com/linxule/mcp-music-studio/blob/main/docs/development.md)（英文）
- [隐私政策](https://music-studio.linxule.com/privacy)。播放不会把你的作品存进分享数据库。实时会话会保留日志，直到最后一次活动后两小时；念白内容会缓存 30 天。能把音乐装进 URL 的链接，数据就带在链接本身里。请不要在乐谱、代码、标题或念白中写入隐私信息。`create-share-link` 只在你提出要求时才会托管作品。
- [报告问题](https://github.com/linxule/mcp-music-studio/issues)

## 致谢与许可证

本项目 fork 自 Anthropic 的 [MCP ext-apps](https://github.com/modelcontextprotocol/ext-apps) 中的 [Sheet Music Server](https://github.com/modelcontextprotocol/ext-apps/tree/main/examples/sheet-music-server) 示例（MIT）。现场编程使用 [Strudel](https://codeberg.org/uzu/strudel)，乐谱使用 [abcjs](https://github.com/paulrosen/abcjs)，着色器视觉使用 [hydra-synth](https://hydra.ojack.xyz)。

以 AGPL-3.0-or-later 授权。原始 MIT 声明见 [LICENSES/MIT.txt](https://github.com/linxule/mcp-music-studio/blob/main/LICENSES/MIT.txt)。对应源代码见 [SOURCE.md](https://github.com/linxule/mcp-music-studio/blob/main/SOURCE.md)，依赖与音频授权见 [THIRD_PARTY_NOTICES.md](https://github.com/linxule/mcp-music-studio/blob/main/THIRD_PARTY_NOTICES.md)。你创作的音乐不会自动套用本软件的许可证。
