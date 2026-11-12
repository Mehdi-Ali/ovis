<p align="center">
  <img src="public/icons/icon-192.png" alt="Ovis" width="100">
</p>

<h1 align="center">Ovis</h1>

<p align="center">
  <strong>自分のコンピューターで動く Claude Code や Codex などのコーディングエージェントと、<br>デスクトップ、スマートフォン、ブラウザーからチャットできるアプリです。</strong>
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <strong>日本語</strong> · <a href="README.ko.md">한국어</a>
  <br>
  <a href="https://ovis.sh/">公式サイト</a> ·
  <a href="#install">インストール</a> ·
  <a href="https://ovis.sh/demo/">デモを試す</a> ·
  <a href="docs/guide.md#quick-start">クイックスタート</a> ·
  <a href="docs/guide.md#faq">よくある質問</a> ·
  <a href="https://ovis.sh/discord">Discord</a> ·
  <a href="#docs">ドキュメント</a>
</p>

<p align="center">
  <a href="https://ovis.sh/demo/"><img src="docs/media/readme/desktop-and-phone.webp" width="830" alt="デスクトップのブラウザーとスマートフォンで見た Ovis。デスクトップには、ワークスペースとエージェントの一覧の横に Claude Code との会話がチャットとして表示されています。スマートフォンには、git push origin feat/export-guard を実行してよいかを尋ねる Codex の Allow command? カードが、Yes、Yes and don't ask again for git push、No の選択肢とともに表示されています。"></a>
</p>

<p align="center">
  エージェントに作業を任せたまま、どこからでも返事をしたい人のためのアプリです。
  <br>
  <strong>入手：</strong><a href="https://ovis.sh/Ovis-mac-arm64.dmg">Mac</a>（<a href="https://ovis.sh/Ovis-mac-x64.dmg">Intel</a>）· <a href="https://ovis.sh/Ovis-win-x64.exe">Windows</a> · <a href="https://ovis.sh/Ovis-linux-x64.deb">Linux</a>（<a href="docs/guide.md#the-desktop-app">その他</a>）
  <br>
  <strong>スマートフォン：</strong><a href="https://ovis.sh/ja/beta/">iPhone・Android</a>（ベータ版）
</p>

<a id="install"></a>

## インストール

Ovis は、エージェントが動いているそのコンピューターで動きます。スマートフォンや別のブラウザーはそこに接続するだけなので、まずコンピューターを用意してください。

**コンピューターに：** 上のリンクからデスクトップアプリを入手します。ほかに何も要らず、独自のターミナルを使います。「Windows によって PC が保護されました」と表示されたら、**詳細情報** → **実行** を選んでください。[すべてのビルド →](docs/guide.md#the-desktop-app)

**すでに herdr や Herdr アプリを使っていますか？** デスクトップアプリの代わりに、コマンド 1 行で Ovis を入れて一緒に使えます（[そのとき表示されるターミナル](#how-it-fits-with-herdr)）。Linux か macOS で：

```bash
curl -fsSL https://ovis.sh/install.sh | sh
```

Windows では PowerShell で：

```powershell
irm https://ovis.sh/install.ps1 | iex
```

**スマートフォンに：** コンピューターで **設定 → デバイスと PC → 接続を追加 → Ovis リレー** を開いてスイッチをオンにし、表示された QR コードをスマートフォンのカメラで読み取ります。スマートフォンのブラウザーで Ovis が開きます。ホーム画面に追加して使うか、アプリとして使うなら [iPhone・Android のベータ版](https://ovis.sh/ja/beta/)に参加してください。[スマートフォンの設定 →](docs/guide.md#on-your-phone)

## できること

- **エージェントをチャットとして読む。** 1 ターンのコマンドや編集は、開いて確認できる 1 行にまとまります。
- **タップで答える。** 承認の確認や質問がカードで届きます。
- **新しいエージェントを始める。** デスクトップからでもスマートフォンからでも、フォルダーを選んで始められます。
- **エージェントに呼ばれたら分かる。** アプリを閉じていてもプッシュ通知が届きます。
- **本物のターミナルを開く。** ワンクリックで開き、スマートフォンにはキーバーが付きます。

<details>
<summary>動いている様子を見る（25 秒の動画）</summary>
<p align="center">
  <a href="https://ovis.sh/demo/"><img src="docs/media/readme/hero.webp" alt="デモで収録した Ovis の画面：デスクトップのブラウザーで Claude Code に続きのメッセージを送るとターンが一歩ずつ進み、次にデスクトップとスマートフォンが並び、git push origin feat/export-guard を確認する Codex の Allow command? カードでスマートフォンから Yes をタップすると両方の画面でカードが閉じ、最後に release タブをクリックするとシェルのペインが git log と bun test を実行する本物のターミナルとして開きます。"></a>
  <br>
  <sub>ブラウザーで動く<a href="https://ovis.sh/demo/">デモ</a>で収録しました。</sub>
</p>
</details>

<a id="how-it-fits-with-herdr"></a>

## herdr との関係

- [**herdr**](https://github.com/herdrdev/herdr) はコーディングエージェントのためのターミナルマルチプレクサーです。エージェントのターミナルを動かし続け、どのエージェントが作業中か、止まっているか、待機中かを把握します。
- [**Herdr アプリ**](https://herdr.dev/download/)は herdr 自身のデスクトップアプリで、そのターミナルは [**herdr-core**](https://herdr.dev/core)（`hc`）の上で動きます。
- **Ovis** はこれらの上に作った独立したプロジェクトです。同じターミナルを、チャット、スマートフォンアプリ、ブラウザーから使えるようにします。

Ovis はこれらのどれかを置き換えるものではありません。Ovis に表示される herdr のセッションや Herdr アプリのターミナルは、herdr や Herdr アプリで見ているのと同じ、実際に動いているターミナルなので、何も移さずに両方を一緒に使えます。1 行のインストールコマンドで入れると herdr のセッション（herdr 0.9.0 以降）か Herdr アプリのターミナルが表示され、デスクトップアプリは独自のターミナルを使います。[Herdr アプリのターミナル →](docs/guide.md#herdr-app-terminals)

## コンピューターへの接続方法

コンピューターは起動している必要があります。スマートフォンから接続する方法は 3 つあります。

- **[Ovis リレー](docs/guide.md#through-the-ovis-relay)：** QR コードを一度読み取れば、どこからでも使えます。エンドツーエンドで暗号化されますが（[信頼モデル](docs/relay.md#trust-model)）、通信は `relay.ovis.sh` を経由し、常時稼働は保証されません。
- **同じ Wi-Fi：** リレーで一度ペアリングすると、iPhone・Android アプリはコンピューターと同じネットワークの中では直接つながり、それができない場所ではリレーを使います。
- **Tailscale：** 自分の Tailscale ネットワーク内だけで開ける HTTPS アドレスを使います。Ovis リレーは通りませんが、コンピューターとスマートフォンの両方に Tailscale が必要です。

VPN、SSH トンネル、自前の HTTPS プロキシでも使えます（[アクセスと安全性](docs/guide.md#access-and-safety)）。

**プライバシー：** セッションは自分のコンピューターに残り、アカウントなしで使えます。匿名の利用集計はデフォルトで有効で、**設定 → 情報** か `OVIS_TELEMETRY=0` でオフにできます（[送信される内容](docs/guide.md#anonymous-usage-counts)）。

## エージェント

herdr が動かすエージェントはすべて、リアルタイムの状態、本物のターミナル、通知とともに表示されます。チャットはエージェント自身のセッションファイルを読んで作るため、どこまで使えるかはエージェントによって違います。

- **すべて使える：** Claude Code。
- **ほとんど使える：** Codex、Oh My Pi（omp）、OmO。
- **一部使える：** pi、OpenCode、Hermes、Devin CLI、Antigravity、Grok、Gajae Code（gjc）など。質問や承認のカード、付加機能は少なめです。
- **そのほかのエージェント：** チャットの代わりにターミナルのテキストが表示されます。

本物のターミナルはいつでも使えます。[対応エージェント →](docs/guide.md#supported-agents)

<a id="docs"></a>

## ドキュメント

- **[ユーザーガイド](docs/guide.md)：** [クイックスタート](docs/guide.md#quick-start) · [機能](docs/guide.md#features) · [リモート PC](docs/remote-pcs.md) · [設定](docs/guide.md#configuration) · [キーボードショートカット](docs/guide.md#keyboard-shortcuts) · [よくある質問](docs/guide.md#faq)
- **[INSTALL.md](INSTALL.md)**（すべてのインストール方法の手順）· **[デモ](https://ovis.sh/demo/)** · **[変更履歴](CHANGELOG.md)**
- **コントリビュート：** セットアップとコマンドは [CONTRIBUTING.md](CONTRIBUTING.md) にあり、[開発ドキュメント](docs/development.md)、[DESIGN.md](DESIGN.md)、[SECURITY.md](SECURITY.md) も参照してください。コーディングエージェントは、インストールを支援するときは [INSTALL.md](INSTALL.md) に、リポジトリを変更するときは[レビュールール](.github/REVIEW.md)と [AGENTS.md](AGENTS.md) に従ってください。

ドキュメントは英語で書かれています。

## 謝辞

[herdr](https://github.com/herdrdev/herdr) を基盤とし、[chatmux](https://github.com/devswha/chatmux) から着想を得て、[xterm.js](https://xtermjs.org)、[React](https://react.dev)、[Bun](https://bun.sh)、[Lucide](https://lucide.dev) を使用しています。[@Yoonwoo-Ha](https://github.com/Yoonwoo-Ha) をはじめ、貢献してくださったすべての方に感謝します。アイコンとウェブサイトのデザインを手伝ってくださった [@sanguneo](https://github.com/sanguneo) にも感謝します。

[MIT](LICENSE)。Copyright © 2026 devswha.
