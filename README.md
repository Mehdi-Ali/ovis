<p align="center">
  <img src="public/icons/icon-192.png" alt="Ovis" width="100">
</p>

<h1 align="center">Ovis</h1>

<p align="center">
  <strong>Ovis is a desktop, phone and browser app for chatting with Claude Code, Codex and other coding agents running on your computer.</strong>
</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a>
  <br>
  <a href="https://ovis.sh/">website</a> ·
  <a href="#install">install</a> ·
  <a href="https://ovis.sh/demo/">try the demo</a> ·
  <a href="docs/guide.md#quick-start">quick start</a> ·
  <a href="docs/guide.md#faq">faq</a> ·
  <a href="https://ovis.sh/discord">discord</a> ·
  <a href="#docs">docs</a>
</p>

<p align="center">
  <a href="https://ovis.sh/demo/"><img src="docs/media/readme/desktop-and-phone.webp" width="830" alt="Ovis in a desktop browser and on a phone. The desktop shows a sidebar of workspaces and agents beside a Claude Code conversation read as a chat. The phone shows a Codex pane asking Allow command? for git push origin feat/export-guard, with Yes, Yes and don't ask again for git push, and No as the choices."></a>
</p>

<p align="center">
  For people who leave agents working on their computer and want to answer them from anywhere.
  <br>
  <strong>Get it:</strong> <a href="https://ovis.sh/Ovis-mac-arm64.dmg">Mac</a> (<a href="https://ovis.sh/Ovis-mac-x64.dmg">Intel</a>) · <a href="https://ovis.sh/Ovis-win-x64.exe">Windows</a> · <a href="https://ovis.sh/Ovis-linux-x64.deb">Linux</a> (<a href="docs/guide.md#the-desktop-app">more</a>)
  <br>
  <strong>Then your phone:</strong> <a href="https://ovis.sh/beta/">iPhone and Android</a> (beta)
</p>

## install

Ovis runs on the computer where your agents run. A phone or another browser only connects to it, so set up the computer first.

**On your computer:** the desktop app, from the links above. It needs nothing else and brings its own terminals. If Windows shows **Windows protected your PC**, choose **More info** → **Run anyway**. [Every build →](docs/guide.md#the-desktop-app)

**Already use herdr or the Herdr app?** One command sets Ovis up beside it instead ([what it then shows](#how-it-fits-with-herdr)). On Linux or macOS:

```bash
curl -fsSL https://ovis.sh/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://ovis.sh/install.ps1 | iex
```

**On your phone:** on the computer, open **Settings → Devices and PCs → Add a connection → Ovis relay**, switch it on and scan its QR code with the phone's camera. Ovis opens in the phone's browser; add it to the home screen, or join the [iPhone or Android beta](https://ovis.sh/beta/) for an app. [Phone setup →](docs/guide.md#on-your-phone)

## what you can do

- **Read an agent as a chat.** A turn's commands and edits fold into one line you can open.
- **Answer with a tap.** Approvals and questions arrive as cards.
- **Start a new agent** in a folder you pick, from the desktop or the phone.
- **Know when one needs you.** Push alerts, even with the app closed.
- **Open the real terminal** in one click, with a key bar on phones.

<details>
<summary>Watch it in motion (a 25-second clip)</summary>
<p align="center">
  <a href="https://ovis.sh/demo/"><img src="docs/media/readme/hero.webp" alt="Screen recording of Ovis on the demo: in a desktop browser, a follow-up is sent to Claude Code and its turn streams in step by step; then the desktop and a phone side by side, where Codex asks Allow command? for git push origin feat/export-guard, Yes is tapped on the phone and the card closes on both screens; then a click on the release tab opens a shell pane as a live terminal running git log and bun test."></a>
  <br>
  <sub>Recorded on the <a href="https://ovis.sh/demo/">demo</a>, which runs in your browser.</sub>
</p>
</details>

## how it fits with herdr

- **[herdr](https://github.com/herdrdev/herdr)** is a terminal multiplexer for coding agents. It keeps their terminals running and knows which agent is working, blocked or idle.
- **The [Herdr app](https://herdr.dev/download/)** is herdr's own desktop app. Its terminals run on **[herdr-core](https://herdr.dev/core)** (`hc`).
- **Ovis** is an independent project on top of them: a chat, a phone app and a browser client for the same terminals.

Ovis replaces none of them: the terminals it shows from herdr or the Herdr app are the same live ones, so you use both at once, with nothing to move over. The one-line install shows your herdr sessions (herdr 0.9.0 or newer) or the Herdr app's terminals, and the desktop app keeps terminals of its own. [Herdr app terminals →](docs/guide.md#herdr-app-terminals)

## reaching your computer

Your computer has to be on. A phone reaches it in one of three ways:

- **[Ovis relay](docs/guide.md#through-the-ovis-relay):** works from anywhere after one QR scan. It is end-to-end encrypted ([trust model](docs/relay.md#trust-model)), but runs through `relay.ovis.sh` on a best effort.
- **Same Wi-Fi:** once paired through the relay, the iPhone and Android apps connect straight to the computer, on its own network only.
- **Tailscale:** an HTTPS address inside your own Tailscale network. It skips the Ovis relay, but needs Tailscale on the computer and the phone.

A VPN, an SSH tunnel or your own HTTPS proxy work too ([access and safety](docs/guide.md#access-and-safety)).

**Privacy:** sessions stay on your computer, and no account is needed. Anonymous usage counts are on by default; **Settings → About** or `OVIS_TELEMETRY=0` turns them off ([what is sent](docs/guide.md#anonymous-usage-counts)).

## agents

Every agent herdr runs shows up with its live status, its real terminal and alerts. Chat is read from the agent's own session files, so how much of it works depends on the agent:

- **All of it:** Claude Code.
- **Most of it:** Codex, Oh My Pi (omp) and OmO.
- **Part of it:** pi, OpenCode, Hermes, Devin CLI, Antigravity, Grok, Gajae Code (gjc) and others, with fewer prompt cards and extras.
- **Any other agent:** the terminal's text where the chat would be.

The real terminal always works. [Supported agents →](docs/guide.md#supported-agents)

## docs

- **[User guide](docs/guide.md):** [quick start](docs/guide.md#quick-start) · [features](docs/guide.md#features) · [remote PCs](docs/remote-pcs.md) · [configuration](docs/guide.md#configuration) · [keyboard shortcuts](docs/guide.md#keyboard-shortcuts) · [FAQ](docs/guide.md#faq)
- **[INSTALL.md](INSTALL.md)**, every way to install step by step · **[Demo](https://ovis.sh/demo/)** · **[Changelog](CHANGELOG.md)**
- **Contributing:** [CONTRIBUTING.md](CONTRIBUTING.md) has the setup and the commands, with [development](docs/development.md), [DESIGN.md](DESIGN.md) and [SECURITY.md](SECURITY.md). Coding agents install Ovis for someone with [INSTALL.md](INSTALL.md), and follow the [review rules](.github/REVIEW.md) and [AGENTS.md](AGENTS.md) for changes.

## thanks

Built on [herdr](https://github.com/herdrdev/herdr), with inspiration from [chatmux](https://github.com/devswha/chatmux), and powered by [xterm.js](https://xtermjs.org), [React](https://react.dev), [Bun](https://bun.sh) and [Lucide](https://lucide.dev). Thanks to everyone who has contributed, including [@Yoonwoo-Ha](https://github.com/Yoonwoo-Ha), and to [@sanguneo](https://github.com/sanguneo), who helped design the icon and the website.

[MIT](LICENSE). Copyright © 2026 devswha.
