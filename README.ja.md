# MCP Music Studio

[English](https://github.com/linxule/mcp-music-studio/blob/main/README.md) · [简体中文](https://github.com/linxule/mcp-music-studio/blob/main/README.zh-CN.md) · [Français](https://github.com/linxule/mcp-music-studio/blob/main/README.fr.md) · **日本語**

[![npm](https://img.shields.io/npm/v/mcp-music-studio)](https://www.npmjs.com/package/mcp-music-studio) [![CI](https://github.com/linxule/mcp-music-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/linxule/mcp-music-studio/actions/workflows/ci.yml) [![License: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](https://github.com/linxule/mcp-music-studio/blob/main/LICENSE)

チャットの中で、AIアシスタントと一緒に音楽を作れます。曲をお願いすれば、再生も編集もできる楽譜が出てきます。ビートをお願いすれば、ビジュアルつきのライブコーディングプレイヤーが出てきます。そのあと、作品を一緒に編集したり、再生しながらコントロールを動かしたり、AIと交代で演奏したりできます。

Music Studio は MCP サーバーです。MCP は、AIアシスタントにツールを足すための標準です。Claude など、対応したチャットアプリが必要です。Claude、claude.ai、そのほか MCP Apps に対応したアプリでは、プレイヤーがチャット内に表示されます。Claude Code やそのほかのターミナルアプリでは、ブラウザでプレイヤーを開くリンクが届きます。

<a href="https://github.com/linxule/mcp-music-studio/releases/download/v0.5.3/mcp-music-studio-v0.5-live-set-1080p60.mp4"><img src="https://raw.githubusercontent.com/linxule/mcp-music-studio/main/assets/live-set-stage.gif" alt="Strudelのパターン。ピアノロールをHydraのシェーダーに渡し、続いてStageモードが画面いっぱいに広がる" width="720"></a>

*プレイヤー上のライブセットです。どのセクションも、音楽を流したまま加えた変更です。[フル動画を見る](https://github.com/linxule/mcp-music-studio/releases/download/v0.5.3/mcp-music-studio-v0.5-live-set-1080p60.mp4)。*

## 使いはじめる

この URL をリモート MCP サーバーとして追加してください。インストールは不要です。

```
https://music-studio.linxule.com/mcp
```

- **Claude と claude.ai:** Settings（設定）を開き、Connectors（コネクタ）からカスタムコネクタを追加して、URL を貼り付けます。
- **Claude Code:** `claude mcp add --transport http music-studio https://music-studio.linxule.com/mcp` を実行します。

あとは曲、ビート、ミュージックビデオをお願いするだけです。アカウントは不要です。ブラウザによっては、プレイヤーで一度 Play（再生）をタップするまで音が出ません。

## 作れるもの

- **楽譜。** ABC記譜法のスコアを楽譜として描き、128種の General MIDI 楽器のどれでも再生できます。スタイル（ロック、ジャズ、ボサノヴァなど）を足すと、ドラム、ベース、コードがつきます。その場でスコアを編集し、移調し、WAV や MIDI をダウンロードできます。[楽譜について](https://github.com/linxule/mcp-music-studio/blob/main/docs/sheet-music.md)（英語）
- **ライブコーディング。** [Strudel](https://strudel.cc)（TidalCycles の JavaScript 版）のパターンを、再生しながら書き換えられるエディタで扱えます。ドラムマシン、シンセ、エフェクト、ピアノロール、音楽に追従する Hydra のシェーダー映像。[ライブコーディングについて](https://github.com/linxule/mcp-music-studio/blob/main/docs/live-coding.md)（英語）
- **ミュージックビデオとステージ作品。** パターンのコードは絵を描き、すべての音に反応し、タップに応え、音楽に合わせてセリフを話せます。ガイドのギャラリーには、短編映画、セリフのデュエット、作曲するライフゲームがあります。
- **一緒に演奏する。** ライブセッションでは、プレイヤーをひとつ開いたままにします。AI はあなたの操作を読み、同じプレイヤーに次の小節から返事を載せます。フェーダー、パッド、スマホの動きがコントロールになります。[一緒に演奏することについて](https://github.com/linxule/mcp-music-studio/blob/main/docs/playing-together.md)（英語）
- **共有。** スコアやパターンがリンクに収まる大きさなら、返信にフルプレイヤーを開くリンクがつきます。大きな作品は、保存付きのリンクを頼んでください。30日間有効です。

## ツール

| ツール | できること |
|------|--------------|
| `play-sheet-music` | ABC記譜法で書いたスコアを描画し、再生する |
| `play-live-pattern` | Strudel コード用のライブコーディングプレイヤーを開く。ライブセッションにもできる |
| `get-session` | ライブセッションで起きたことを読む。聴いている人が Pass（手番を渡す）を押すまで待つこともできる |
| `update-session` | ライブセッションのプレイヤーのコードを、次の小節またはフレーズで新しいコードに差し替える |
| `get-music-guide` | ABC記譜法のリファレンス。構文、楽器、スタイル、ジャンル |
| `get-strudel-guide` | Strudel のリファレンス。サウンド、エフェクト、ビジュアル、ステージ、ギャラリー作品 |
| `search-music-docs` | Strudel と abcjs のドキュメントを検索する |
| `analyze-harmony` | コードに名前をつけ、キーを見つけ、進行を組み立てる |
| `convert-abc-to-strudel` | 楽譜のメロディを Strudel のパターンにする |
| `create-share-link` | 作品を30日間保存し、誰でも開けるリンクを返す |

パラメータ、プロンプト、プレイヤー自身のツール：[ツールとプロンプト](https://github.com/linxule/mcp-music-studio/blob/main/docs/tools.md)（英語）。

## 自分のコンピュータで動かす

ホスト済みの URL はセットアップ不要です。サーバーをローカルで動かす場合は、npm を使います。

```bash
claude mcp add music-studio -- npx -y mcp-music-studio --stdio
```

Claude Desktop、Codex、Gemini CLI、VS Code、Cursor、Windsurf などの設定、レンダーモード、HTTP モード：[インストールとクライアント設定](https://github.com/linxule/mcp-music-studio/blob/main/docs/install.md)（英語）。

## その他

- [更新履歴](https://github.com/linxule/mcp-music-studio/blob/main/CHANGELOG.md)（英語）
- [開発](https://github.com/linxule/mcp-music-studio/blob/main/docs/development.md)（英語）
- [プライバシーポリシー](https://music-studio.linxule.com/privacy)。再生だけでは、作品は共有データベースに保存されません。ライブセッションは、最後の操作から2時間がたつまでログを残します。話したセリフは30日間キャッシュされます。音楽を URL に収めたリンクは、データがリンクそのものに入っています。スコア、コード、タイトル、セリフに個人情報を入れないでください。`create-share-link` は、頼んだときだけ作品を保存します。
- [問題を報告する](https://github.com/linxule/mcp-music-studio/issues)

## クレジットとライセンス

Anthropic の [MCP ext-apps](https://github.com/modelcontextprotocol/ext-apps) にある [Sheet Music Server](https://github.com/modelcontextprotocol/ext-apps/tree/main/examples/sheet-music-server) の例（MIT）からフォークしています。ライブコーディングは [Strudel](https://codeberg.org/uzu/strudel)、記譜は [abcjs](https://github.com/paulrosen/abcjs)、シェーダー映像は [hydra-synth](https://hydra.ojack.xyz) を使っています。

ライセンスは AGPL-3.0-or-later です。元の MIT 告知は [LICENSES/MIT.txt](https://github.com/linxule/mcp-music-studio/blob/main/LICENSES/MIT.txt) にあります。対応するソースは [SOURCE.md](https://github.com/linxule/mcp-music-studio/blob/main/SOURCE.md)、依存関係と音声のライセンスは [THIRD_PARTY_NOTICES.md](https://github.com/linxule/mcp-music-studio/blob/main/THIRD_PARTY_NOTICES.md) を見てください。あなたが作った音楽に、ソフトウェアのライセンスが自動でかかることはありません。
