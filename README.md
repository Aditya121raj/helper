<div align="center">

# NoView
### Open-Source Cluely Alternative

**See more. Know faster. Stay invisible.**

[![Releases](https://img.shields.io/badge/Releases-GitHub-success?style=for-the-badge&logo=github&logoColor=white&labelColor=2B213A)](https://github.com/Aditya121raj/helper/releases)
[![Developer](https://img.shields.io/badge/Developer-@Aditya121raj-blue?style=for-the-badge&logo=github&logoColor=white&labelColor=1E88E5)](https://github.com/Aditya121raj)
[![Platform](https://img.shields.io/badge/Platform-Windows-teal?style=for-the-badge&logo=windows&logoColor=white&labelColor=2C3E50)](https://github.com/Aditya121raj/helper)


<img src="./public/assets/icons/noview_logo.svg" width="220px" alt="NoView logo"/>

</div>

---

## What is NoView?

**NoView** is a privacy-first, open-source AI assistant that operates **silently across your screen**.

It captures your screen only when requested, sends it to your configured AI provider for analysis, and displays a contextual response in a discreet overlay.

Built for people who value **speed, discretion, and control**.

---

## Why NoView?

Most AI tools are loud.  
Some are expensive.  
Almost all watch you back.

**NoView doesn’t.**

- No subscriptions  
- No accounts  
- No built-in usage counter or analytics
- API keys protected with the operating system's secure storage
- No lock-in  

Just a tool that does its job — quietly.

---

## ✨ Core Capabilities

- **Invisible by Design**  
  Lives off-screen. Appears only when summoned. Leaves no trace.

- **Context-Aware Intelligence**  
  Understands what app you’re using and adapts responses accordingly.

- **Privacy Comes First**  
  Screenshots are submitted only when you trigger analysis. NoView does not include a usage counter or analytics service.

- **Open Source**  
  Every line is auditable.

---

## ⌨️ Keyboard-Driven Workflow

### Global
| Shortcut | Action |
|--------|-------|
| `Ctrl + \` | Toggle NoView |

### When Visible
| Shortcut | Action |
|--------|-------|
| `Ctrl + Enter` | Capture screen & analyze |
| `Ctrl + M` | Start/stop Windows System Audio input |
| `Ctrl + Shift + M` | Start/stop default microphone input |
| `Ctrl + R` | Cancel current task |
| `Ctrl + ← → ↑ ↓` | Move window |
| `Alt + ↑ ↓` | Scroll content |
| `Alt + ← →` | Scroll code blocks |
| `Ctrl + Shift + ↑ ↓` | Navigate history |
| `Ctrl + ,` | Open settings |
| `Ctrl + Shift + ,` | Interactive settings |
| `Ctrl + Shift + V` | Transparent mode |
| `Ctrl + Shift + R` | Emergency recovery |
| `Ctrl + Q` | Quit |

> Tip: NoView can be toggled even while hidden.
> No task switching. No attention break.


---

## 🤖 AI Setup

1. Press `Ctrl + ,` to open settings.
2. Press `Ctrl + Shift + ,` to make the settings panel interactive.
3. Select **Google Gemini**, enter your Gemini API key, and save.
4. NoView defaults to `gemini-3.6-flash` with low thinking latency.

Your API key is encrypted using Electron `safeStorage`. Screen content is sent to the provider you configure, so review that provider's privacy and billing terms.

---

## 🛠️ Run from Source

Requirements: a current Node.js LTS release, npm, and Git.

```powershell
git clone https://github.com/Aditya121raj/helper.git
cd helper
npm install
npm run dev
```

Build the Windows installer with:

```powershell
npm run build:win
```

The installer is written to the `release` directory. Packaging the Windows voice runtime also requires Python.

---

## 📥 Download

NoView is currently available for **Windows**.

👉 **[Check GitHub Releases](https://github.com/Aditya121raj/helper/releases)**

If no release asset is published yet, use the source instructions above.

macOS & Linux builds are planned.

---

## ⚠️ Ethical Use

> NoView is a general-purpose assistant.
> Use it responsibly and in compliance with applicable rules, policies, and laws.

The developers are not responsible for misuse.

---

## 💎 Support the Project

<div align="center">
  <a href="https://github.com/Aditya121raj/helper">
    <img src="https://img.shields.io/badge/Support%20Aditya%20Raj-Teal?style=for-the-badge"/>
  </a>
</div>

---

## 🕶️ Philosophy

NoView is built around a simple idea:

> **The best tools don’t demand attention. They amplify it.**

Research, debugging, and problem-solving under pressure.
When timing matters, NoView stays quiet and ready.

---

## 🌐 Project Links

<div align="center">
  <a href="https://github.com/Aditya121raj">
    <img src="https://img.shields.io/badge/GitHub-@Aditya121raj-000000?style=for-the-badge&logo=github"/>
  </a>
  <p><a href="https://github.com/Aditya121raj/helper/issues">Report an issue</a> · <a href="https://github.com/Aditya121raj/helper/releases">View releases</a></p>
</div>

---

<div align="center">
  <strong>Aditya Raj</strong>
</div>

<div align="center">
<img src="https://komarev.com/ghpvc/?username=Aditya121raj&repo=helper&label=Repo%20Views&color=olive&style=pixel&abbreviated=true"/>
</div>
