#!/usr/bin/env bash
# Install or update tgmux on a Debian host. Run from the repo root as the service user (with sudo rights).
set -euo pipefail
command -v tmux >/dev/null || sudo apt-get install -y tmux
command -v bun >/dev/null || [ -x ~/.bun/bin/bun ] || curl -fsSL https://bun.sh/install | bash
[ -x ~/.local/bin/claude ] || curl -fsSL https://claude.ai/install.sh | bash
mkdir -p ~/.config/tgmux
[ -f ~/.config/tgmux/env ] || { umask 077; cp .env.example ~/.config/tgmux/env; echo "Fill in ~/.config/tgmux/env, then rerun."; exit 1; }
sudo cp deploy/tgmux.service /etc/systemd/system/tgmux.service
sudo systemctl daemon-reload
sudo systemctl enable --now tgmux
sudo systemctl restart tgmux
systemctl --no-pager status tgmux | head -5
