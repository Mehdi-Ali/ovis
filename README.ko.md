<p align="center">
  <img src="public/icons/icon-192.png" alt="Ovis" width="100">
</p>

<h1 align="center">Ovis</h1>

<p align="center">
  <strong>Ovis는 내 컴퓨터에서 돌아가는 Claude Code, Codex 같은 코딩 에이전트와<br>데스크톱, 휴대폰, 브라우저에서 채팅하는 앱입니다.</strong>
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a> · <strong>한국어</strong>
  <br>
  <a href="https://ovis.sh/">웹사이트</a> ·
  <a href="#install">설치</a> ·
  <a href="https://ovis.sh/demo/">데모 체험</a> ·
  <a href="docs/guide.md#quick-start">빠른 시작</a> ·
  <a href="docs/guide.md#faq">자주 묻는 질문</a> ·
  <a href="https://ovis.sh/discord">디스코드</a> ·
  <a href="#docs">문서</a>
</p>

<p align="center">
  <a href="https://ovis.sh/demo/"><img src="docs/media/readme/desktop-and-phone.webp" width="830" alt="데스크톱 브라우저와 휴대폰에서 본 Ovis. 데스크톱에는 워크스페이스와 에이전트 목록 옆에 Claude Code와의 대화가 채팅으로 보이고, 휴대폰에는 Codex가 git push origin feat/export-guard를 실행해도 되는지 묻는 Allow command? 카드가 Yes, Yes and don't ask again for git push, No 선택지와 함께 보입니다."></a>
</p>

<p align="center">
  일을 맡긴 에이전트에게 어디서든 답하려는 분께.
  <br>
  <strong>받기:</strong> <a href="https://ovis.sh/Ovis-mac-arm64.dmg">Mac</a> (<a href="https://ovis.sh/Ovis-mac-x64.dmg">Intel</a>) · <a href="https://ovis.sh/Ovis-win-x64.exe">Windows</a> · <a href="https://ovis.sh/Ovis-linux-x64.deb">Linux</a> (<a href="docs/guide.md#the-desktop-app">더 보기</a>)
  <br>
  <strong>그다음 휴대폰에:</strong> <a href="https://ovis.sh/ko/beta/">iPhone과 Android</a> (베타)
</p>

<a id="install"></a>

## 설치

Ovis는 에이전트가 돌아가는 바로 그 컴퓨터에서 실행됩니다. 휴대폰이나 다른 브라우저는 그 컴퓨터에 연결할 뿐이니, 컴퓨터부터 준비하세요.

**컴퓨터에서:** 위 링크에서 데스크톱 앱을 받으세요. 따로 설치할 것이 없고 자체 터미널을 씁니다. Windows가 'PC 보호' 화면을 띄우면 **추가 정보** → **실행**을 누르세요. [모든 빌드 →](docs/guide.md#the-desktop-app)

**이미 herdr나 Herdr 앱을 쓰고 있나요?** 그렇다면 데스크톱 앱 대신 명령 한 줄로 Ovis를 설치해 함께 쓸 수 있습니다([그때 보이는 터미널](#how-it-fits-with-herdr)). Linux나 macOS에서:

```bash
curl -fsSL https://ovis.sh/install.sh | sh
```

Windows에서는 PowerShell에서:

```powershell
irm https://ovis.sh/install.ps1 | iex
```

**휴대폰에서:** 컴퓨터에서 **설정 → 기기와 PC → 연결 추가 → Ovis 릴레이**를 열어 스위치를 켜고, 나타나는 QR 코드를 휴대폰 카메라로 찍으세요. 휴대폰 브라우저에서 Ovis가 열립니다. 홈 화면에 추가해서 쓰거나, 앱으로 쓰려면 [iPhone·Android 베타](https://ovis.sh/ko/beta/)에 참여하세요. [휴대폰 설정 →](docs/guide.md#on-your-phone)

## 할 수 있는 일

- **에이전트를 채팅으로 읽습니다.** 한 턴의 명령과 수정은 펼쳐 볼 수 있는 한 줄로 접힙니다.
- **탭 한 번으로 답합니다.** 승인 요청과 질문이 카드로 뜹니다.
- **새 에이전트를 시작합니다.** 데스크톱에서든 휴대폰에서든 폴더를 골라 시작합니다.
- **에이전트가 나를 찾으면 알려 줍니다.** 앱이 닫혀 있어도 푸시 알림이 옵니다.
- **실제 터미널을 엽니다.** 클릭 한 번이면 열리고, 휴대폰에는 키 바가 붙습니다.

<details>
<summary>움직이는 모습 보기 (25초 영상)</summary>
<p align="center">
  <a href="https://ovis.sh/demo/"><img src="docs/media/readme/hero.webp" alt="데모에서 녹화한 Ovis 화면: 데스크톱 브라우저에서 Claude Code에 후속 메시지를 보내자 턴이 단계별로 진행되고, 이어서 데스크톱과 휴대폰이 나란히 나와 git push origin feat/export-guard 실행을 묻는 Codex의 Allow command? 카드에서 휴대폰으로 Yes를 누르면 두 화면에서 함께 카드가 닫히고, 마지막으로 release 탭을 누르면 셸 패널이 git log와 bun test를 실행하는 실제 터미널로 열립니다."></a>
  <br>
  <sub>브라우저에서 바로 열리는 <a href="https://ovis.sh/demo/">데모</a>로 녹화했습니다.</sub>
</p>
</details>

<a id="how-it-fits-with-herdr"></a>

## herdr와의 관계

- [**herdr**](https://github.com/herdrdev/herdr)는 코딩 에이전트를 위한 터미널 멀티플렉서입니다. 에이전트의 터미널을 계속 돌려 두고, 어느 에이전트가 일하는 중인지, 막혀 있는지, 대기 중인지 압니다.
- [**Herdr 앱**](https://herdr.dev/download/)은 herdr가 직접 내놓은 데스크톱 앱이고, 그 터미널은 [**herdr-core**](https://herdr.dev/core)(`hc`) 위에서 돌아갑니다.
- **Ovis**는 이들 위에 만든 독립 프로젝트입니다. 같은 터미널을 채팅, 휴대폰 앱, 브라우저로 쓰게 해 줍니다.

Ovis는 이 가운데 어느 것도 대신하지 않습니다. Ovis에 보이는 herdr 세션과 Herdr 앱 터미널은 herdr나 Herdr 앱에서 보는, 지금 돌아가는 바로 그 터미널이라서 옮길 것 없이 둘을 함께 쓰면 됩니다. 한 줄 설치 명령으로 설치하면 내 herdr 세션(herdr 0.9.0 이상)이나 Herdr 앱의 터미널이 보이고, 데스크톱 앱은 자체 터미널을 따로 씁니다. [Herdr 앱 터미널 →](docs/guide.md#herdr-app-terminals)

## 내 컴퓨터에 접속하는 방법

컴퓨터는 켜져 있어야 합니다. 휴대폰에서 접속하는 방법은 세 가지입니다.

- **[Ovis 릴레이](docs/guide.md#through-the-ovis-relay):** QR 코드를 한 번 찍으면 어디서든 쓸 수 있습니다. 종단 간 암호화되지만([신뢰 모델](docs/relay.md#trust-model)) `relay.ovis.sh`를 거치며, 항상 켜져 있다고 약속하는 서비스는 아닙니다.
- **같은 Wi-Fi:** 릴레이로 한 번 페어링해 두면 iPhone·Android 앱이 같은 네트워크에서는 컴퓨터에 바로 연결되고, 그게 안 되는 곳에서는 릴레이를 씁니다.
- **Tailscale:** 내 Tailscale 네트워크 안에서만 열리는 HTTPS 주소를 씁니다. Ovis 릴레이를 거치지 않지만, 컴퓨터와 휴대폰 양쪽에 Tailscale이 있어야 합니다.

VPN, SSH 터널, 직접 운영하는 HTTPS 프록시로도 됩니다([접근과 보안](docs/guide.md#access-and-safety)).

**개인정보:** 세션은 내 컴퓨터에 남고, 계정 없이 쓸 수 있습니다. 익명 사용 집계는 기본으로 켜져 있고, **설정 → 정보**나 `OVIS_TELEMETRY=0`으로 끕니다([보내는 내용](docs/guide.md#anonymous-usage-counts)).

## 에이전트

herdr가 돌리는 에이전트는 모두 실시간 상태, 실제 터미널, 알림과 함께 나타납니다. 채팅은 에이전트가 남기는 세션 파일을 읽어서 만들기 때문에, 얼마나 되는지는 에이전트마다 다릅니다.

- **전부 됨:** Claude Code.
- **대부분 됨:** Codex, Oh My Pi(omp), OmO.
- **일부 됨:** pi, OpenCode, Hermes, Devin CLI, Antigravity, Grok, Gajae Code(gjc) 등. 질문·승인 카드와 부가 기능이 적습니다.
- **그 밖의 에이전트:** 채팅 대신 터미널의 텍스트가 그대로 보입니다.

실제 터미널은 언제나 작동합니다. [지원 에이전트 →](docs/guide.md#supported-agents)

<a id="docs"></a>

## 문서

- **[사용자 가이드](docs/guide.md):** [빠른 시작](docs/guide.md#quick-start) · [기능](docs/guide.md#features) · [원격 PC](docs/remote-pcs.md) · [설정](docs/guide.md#configuration) · [키보드 단축키](docs/guide.md#keyboard-shortcuts) · [자주 묻는 질문](docs/guide.md#faq)
- **[INSTALL.md](INSTALL.md)**(모든 설치 방법을 단계별로) · **[데모](https://ovis.sh/demo/)** · **[변경 기록](CHANGELOG.md)**
- **기여:** 준비 과정과 명령은 [CONTRIBUTING.md](CONTRIBUTING.md)에 있고, [개발 문서](docs/development.md), [DESIGN.md](DESIGN.md), [SECURITY.md](SECURITY.md)도 참고하세요. 코딩 에이전트는 누군가의 설치를 도울 때 [INSTALL.md](INSTALL.md)를, 저장소를 바꿀 때 [리뷰 규칙](.github/REVIEW.md)과 [AGENTS.md](AGENTS.md)를 따릅니다.

문서는 영어로 쓰여 있습니다.

## 감사

[herdr](https://github.com/herdrdev/herdr) 위에서 만들었고, [chatmux](https://github.com/devswha/chatmux)에서 영감을 받았으며, [xterm.js](https://xtermjs.org), [React](https://react.dev), [Bun](https://bun.sh), [Lucide](https://lucide.dev)를 사용합니다. 기여해 주신 모든 분께 감사드립니다. 특히 [@Yoonwoo-Ha](https://github.com/Yoonwoo-Ha)님께 감사드립니다. 아이콘과 홈페이지 디자인을 도와주신 [@sanguneo](https://github.com/sanguneo)님께도 감사드립니다.

[MIT](LICENSE). Copyright © 2026 devswha.
