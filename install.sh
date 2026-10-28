#!/bin/sh
# openclaw-wechat-native installer
#   curl -fsSL https://raw.githubusercontent.com/alexdeg92/openclaw-wechat-native/main/install.sh | sh
# Installs the OpenClaw WeChat channel plugin and the `openclaw-wechat` setup helper for the current user.
# No sudo, no daemon changes, no config edits: it prints the next steps instead.
set -eu

PKG="${OPENCLAW_WECHAT_PKG:-openclaw-wechat-native}"
BIN_DIR="${OPENCLAW_WECHAT_BIN_DIR:-$HOME/.local/bin}"

say()  { printf '%s\n' "$*"; }
ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✖\033[0m %s\n' "$*" >&2; exit 1; }

say "Installing the OpenClaw WeChat channel ($PKG)"

[ "$(uname -s)" = "Linux" ] || die "Linux only (the WeChat daemon runs natively on Linux x86-64)."
case "$(uname -m)" in x86_64|amd64) ok "Linux $(uname -m)";; *) die "x86-64 only, found $(uname -m).";; esac

command -v node >/dev/null 2>&1 || die "Node.js not found. Install Node 24.16+ first: https://nodejs.org"
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>24||(a===24&&b>=16)?0:1)' \
  || die "Node $(node -v) is too old. OpenClaw needs Node 24.16+."
ok "Node $(node -v)"

command -v openclaw >/dev/null 2>&1 || die "OpenClaw not found. Install it first: npm install -g openclaw && openclaw onboard"
ok "$(openclaw --version 2>/dev/null | head -n1)"

command -v docker >/dev/null 2>&1 && ok "Docker" || warn "Docker not found: you'll need it to run the agent-wechat daemon."
command -v ffmpeg >/dev/null 2>&1 && ok "ffmpeg" || warn "ffmpeg not found (optional): animated stickers will show one frame."

say ""
say "Installing the plugin into OpenClaw…"
openclaw plugins install "$PKG" || die "openclaw plugins install failed."
ok "plugin installed (takes effect at the next gateway start)"

say "Installing the openclaw-wechat helper…"
npm install -g --no-audit --no-fund "$PKG" >/dev/null 2>&1 \
  || npm install --prefix "$HOME/.local" -g --no-audit --no-fund "$PKG" >/dev/null 2>&1 \
  || die "could not install the helper with npm."
if command -v openclaw-wechat >/dev/null 2>&1; then ok "openclaw-wechat on PATH"
else
  mkdir -p "$BIN_DIR"
  warn "openclaw-wechat is installed but not on PATH. Add this to your shell profile:"
  say  "      export PATH=\"$BIN_DIR:\$PATH\""
fi

say ""
say "Next steps:"
say "  1. Run the agent-wechat daemon on 127.0.0.1 (see README → Installation)."
say "  2. Add the channel to ~/.openclaw/openclaw.json (README → Configuration), with the gateway stopped."
say "  3. openclaw-wechat doctor"
say "  4. openclaw-wechat login        # QR in the terminal; WeChat shows \"<your agent>'s PC\""
say "  5. openclaw daemon start"
say ""
say "Docs: https://github.com/alexdeg92/openclaw-wechat-native"
