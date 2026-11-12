<p align="center">
  <img src="public/icons/icon-192.png" alt="Ovis" width="100">
</p>

<h1 align="center">Ovis</h1>

<p align="center">
  <strong>Ovis 是一款桌面、手机和浏览器应用，<br>用来与你电脑上的 Claude Code 和 Codex 等编程智能体聊天。</strong>
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a>
  <br>
  <a href="https://ovis.sh/">官网</a> ·
  <a href="#install">安装</a> ·
  <a href="https://ovis.sh/demo/">体验演示</a> ·
  <a href="docs/guide.md#quick-start">快速入门</a> ·
  <a href="docs/guide.md#faq">常见问题</a> ·
  <a href="https://ovis.sh/discord">Discord</a> ·
  <a href="#docs">文档</a>
</p>

<p align="center">
  <a href="https://ovis.sh/demo/"><img src="docs/media/readme/desktop-and-phone.webp" width="830" alt="桌面浏览器和手机上的 Ovis。桌面上，工作区和智能体列表旁边是以聊天形式显示的 Claude Code 对话。手机上，Codex 通过 Allow command? 卡片询问是否运行 git push origin feat/export-guard，选项为 Yes、Yes and don't ask again for git push 和 No。"></a>
</p>

<p align="center">
  适合把任务交给智能体之后，想随时随地回复它们的人。
  <br>
  <strong>获取：</strong><a href="https://ovis.sh/Ovis-mac-arm64.dmg">Mac</a>（<a href="https://ovis.sh/Ovis-mac-x64.dmg">Intel</a>）· <a href="https://ovis.sh/Ovis-win-x64.exe">Windows</a> · <a href="https://ovis.sh/Ovis-linux-x64.deb">Linux</a>（<a href="docs/guide.md#the-desktop-app">更多</a>）
  <br>
  <strong>然后是手机：</strong><a href="https://ovis.sh/zh/beta/">iPhone 和 Android</a>（公测）
</p>

<a id="install"></a>

## 安装

Ovis 运行在智能体所在的那台电脑上。手机或其他浏览器只是连接到它，所以请先装好电脑端。

**在电脑上：** 从上面的链接下载桌面应用。它无需额外安装任何东西，自带终端。如果 Windows 显示 **Windows 已保护你的电脑**，请选择 **更多信息** → **仍要运行**。[所有版本 →](docs/guide.md#the-desktop-app)

**已经在用 herdr 或 Herdr 应用？** 也可以不用桌面应用，改用一条命令安装 Ovis，与它配合使用（[届时显示哪些终端](#how-it-fits-with-herdr)）。在 Linux 或 macOS 上运行：

```bash
curl -fsSL https://ovis.sh/install.sh | sh
```

Windows 上请在 PowerShell 中运行：

```powershell
irm https://ovis.sh/install.ps1 | iex
```

**在手机上：** 在电脑上打开 **设置 → 设备和电脑 → 添加连接 → Ovis 中继**，开启开关，然后用手机相机扫描出现的二维码。Ovis 会在手机浏览器中打开。可以把它添加到主屏幕；想以应用形式使用，请加入 [iPhone 或 Android 公测](https://ovis.sh/zh/beta/)。[手机设置 →](docs/guide.md#on-your-phone)

## 能做什么

- **把智能体当作聊天来读。** 每一轮的命令和修改会折叠成可展开的一行。
- **轻点一下即可回答。** 审批和提问以卡片形式出现。
- **启动新的智能体。** 在桌面或手机上选好文件夹即可开始。
- **需要你时会通知你。** 即使应用已关闭也会推送提醒。
- **打开真正的终端。** 一键即达，手机上还有按键栏。

<details>
<summary>看看实际操作（25 秒的录屏）</summary>
<p align="center">
  <a href="https://ovis.sh/demo/"><img src="docs/media/readme/hero.webp" alt="在演示中录制的 Ovis 画面：在桌面浏览器中向 Claude Code 发送后续消息后，它的这一轮逐步展开；接着桌面和手机并排出现，Codex 通过 Allow command? 卡片询问是否运行 git push origin feat/export-guard，在手机上点按 Yes 后两个屏幕上的卡片同时关闭；最后点击 release 标签页，一个 shell 窗格作为运行 git log 和 bun test 的真正终端打开。"></a>
  <br>
  <sub>录制自可在浏览器中运行的<a href="https://ovis.sh/demo/">演示</a>。</sub>
</p>
</details>

<a id="how-it-fits-with-herdr"></a>

## 与 herdr 的关系

- [**herdr**](https://github.com/herdrdev/herdr) 是面向编程智能体的终端复用器。它让智能体的终端持续运行，并知道哪个智能体正在工作、被卡住或空闲。
- [**Herdr 应用**](https://herdr.dev/download/)是 herdr 自己的桌面应用，它的终端运行在 [**herdr-core**](https://herdr.dev/core)（`hc`）之上。
- **Ovis** 是基于它们构建的独立项目：为同一批终端提供聊天界面、手机应用和浏览器客户端。

Ovis 不会取代其中任何一个。Ovis 中显示的 herdr 会话和 Herdr 应用终端，就是你在 herdr 或 Herdr 应用里看到的同一批实时终端，所以无需迁移，两者可以同时使用。用一行安装命令安装后，显示的是你的 herdr 会话（herdr 0.9.0 或更高版本）或 Herdr 应用的终端；桌面应用则使用自己的终端。[Herdr 应用终端 →](docs/guide.md#herdr-app-terminals)

## 如何连接你的电脑

你的电脑需要开着。从手机连接有三种方式：

- **[Ovis 中继](docs/guide.md#through-the-ovis-relay)：** 扫一次二维码，在任何地方都能用。流量经端到端加密（[信任模型](docs/relay.md#trust-model)），但会经过 `relay.ovis.sh`，该服务不保证始终在线。
- **同一 Wi-Fi：** 通过中继配对一次之后，iPhone 和 Android 应用会直接连接电脑，但只在电脑所在的网络内有效。
- **Tailscale：** 使用只在你自己的 Tailscale 网络内可用的 HTTPS 地址。它不经过 Ovis 中继，但电脑和手机都需要运行 Tailscale。

VPN、SSH 隧道或你自己的 HTTPS 代理也可以（[访问与安全](docs/guide.md#access-and-safety)）。

**隐私：** 会话留在你的电脑上，无需账户即可使用。匿名使用统计默认开启，可在 **设置 → 关于** 中或用 `OVIS_TELEMETRY=0` 关闭（[发送哪些内容](docs/guide.md#anonymous-usage-counts)）。

## 智能体

herdr 运行的每个智能体都会显示出来，并附带实时状态、真正的终端和提醒。聊天通过读取智能体自己的会话文件实现，因此完整程度因智能体而异：

- **全部可用：** Claude Code。
- **大部分可用：** Codex、Oh My Pi（omp）和 OmO。
- **部分可用：** pi、OpenCode、Hermes、Devin CLI、Antigravity、Grok、Gajae Code（gjc）等，审批和提问卡片以及附加功能较少。
- **其他智能体：** 聊天的位置显示终端文本。

真正的终端始终可用。[支持的智能体 →](docs/guide.md#supported-agents)

<a id="docs"></a>

## 文档

- **[用户指南](docs/guide.md)：** [快速入门](docs/guide.md#quick-start) · [功能](docs/guide.md#features) · [远程电脑](docs/remote-pcs.md) · [配置](docs/guide.md#configuration) · [键盘快捷键](docs/guide.md#keyboard-shortcuts) · [常见问题](docs/guide.md#faq)
- **[INSTALL.md](INSTALL.md)**（所有安装方式的分步说明）· **[演示](https://ovis.sh/demo/)** · **[更新日志](CHANGELOG.md)**
- **参与贡献：** 环境准备和命令见 [CONTRIBUTING.md](CONTRIBUTING.md)，另见[开发文档](docs/development.md)、[DESIGN.md](DESIGN.md) 和 [SECURITY.md](SECURITY.md)。编程智能体协助他人安装时请遵循 [INSTALL.md](INSTALL.md)，修改仓库时请遵循[审查规则](.github/REVIEW.md)和 [AGENTS.md](AGENTS.md)。

文档以英文撰写。

## 致谢

本项目基于 [herdr](https://github.com/herdrdev/herdr) 构建，灵感来自 [chatmux](https://github.com/devswha/chatmux)，并使用了 [xterm.js](https://xtermjs.org)、[React](https://react.dev)、[Bun](https://bun.sh) 和 [Lucide](https://lucide.dev)。感谢所有贡献者，包括 [@Yoonwoo-Ha](https://github.com/Yoonwoo-Ha)，也感谢帮助设计图标和网站的 [@sanguneo](https://github.com/sanguneo)。

[MIT](LICENSE)。Copyright © 2026 devswha.
