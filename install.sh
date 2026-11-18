#!/usr/bin/env bash
set -euo pipefail

# Адрес репозитория с файлами сборки (замените на свой перед публикацией в GitHub)
REPO_RAW_URL="${REPO_RAW_URL:-https://raw.githubusercontent.com/voynikovbp-ship-it/botpult-vps/main}"
APP_DIR="/opt/botpult"
APP_PORT="3000"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${CYAN}====================================================${NC}"
echo -e "${CYAN}   Автоматическая установка BotPult на Ubuntu VPS   ${NC}"
echo -e "${CYAN}====================================================${NC}"

# 1. Проверка прав root
if [ "${EUID:-$(id -u)}" -ne 0 ]; then
  echo -e "${RED}Ошибка: запустите установщик от имени root (добавьте sudo перед командой).${NC}"
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

# 2. Установка системных пакетов и защиты от брутфорса
echo -e "\n${YELLOW}[1/6] Обновление системы и установка базовых пакетов...${NC}"
apt-get update -qq
apt-get install -y -qq curl gnupg ca-certificates lsb-release build-essential python3 ufw fail2ban

# 3. Безопасная настройка фаервола UFW (без потери текущего SSH-доступа)
echo -e "${YELLOW}[2/6] Настройка фаервола (UFW) и защиты SSH (Fail2Ban)...${NC}"
SSH_PORT=$(sshd -T 2>/dev/null | awk '/^port / {print $2; exit}' || true)
if [ -z "$SSH_PORT" ]; then
  SSH_PORT=$(grep -E '^[[:space:]]*Port[[:space:]]+[0-9]+' /etc/ssh/sshd_config 2>/dev/null | awk '{print $2}' | tail -n 1 || true)
fi
SSH_PORT="${SSH_PORT:-22}"

ufw default deny incoming >/dev/null 2>&1 || true
ufw default allow outgoing >/dev/null 2>&1 || true
ufw allow "${SSH_PORT}/tcp" >/dev/null 2>&1 || true
ufw allow 80/tcp >/dev/null 2>&1 || true
ufw allow 443/tcp >/dev/null 2>&1 || true
ufw --force enable >/dev/null 2>&1 || true

systemctl enable --now fail2ban >/dev/null 2>&1 || true

# 4. Установка Node.js 24 LTS (если не установлен или версия ниже 20)
echo -e "${YELLOW}[3/6] Проверка и установка Node.js 24 LTS...${NC}"
NEED_NODE=1
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node -v | sed -E 's/^v([0-9]+).*/\1/')
  if [ "${NODE_MAJOR:-0}" -ge 20 ]; then
    NEED_NODE=0
  fi
fi

if [ "$NEED_NODE" -eq 1 ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null
  apt-get install -y -qq nodejs
fi

# 5. Установка веб-сервера Caddy (автоматический HTTPS и SSL)
echo -e "${YELLOW}[4/6] Установка веб-сервера Caddy для автоматического HTTPS...${NC}"
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -qq
  apt-get install -y -qq caddy
fi

# 6. Копирование или загрузка файлов BotPult и установка зависимостей
echo -e "${YELLOW}[5/6] Развёртывание файлов BotPult и локальной базы SQLite...${NC}"
mkdir -p "$APP_DIR"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -f "$SCRIPT_DIR/server.js" ] && [ -f "$SCRIPT_DIR/bot.js" ] && [ -f "$SCRIPT_DIR/index.html" ] && [ -f "$SCRIPT_DIR/package.json" ]; then
  cp -f "$SCRIPT_DIR/package.json" "$APP_DIR/package.json"
  cp -f "$SCRIPT_DIR/server.js" "$APP_DIR/server.js"
  cp -f "$SCRIPT_DIR/bot.js" "$APP_DIR/bot.js"
  cp -f "$SCRIPT_DIR/index.html" "$APP_DIR/index.html"
else
  for FILE in package.json server.js bot.js index.html; do
    curl -fsSL "${REPO_RAW_URL}/${FILE}" -o "${APP_DIR}/${FILE}"
  done
fi

cd "$APP_DIR"
npm install --omit=dev --silent

# Настройка системной службы systemd для автозапуска
cat <<EOF > /etc/systemd/system/botpult.service
[Unit]
Description=BotPult Telegram Funnel Constructor
After=network.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
Environment=PORT=${APP_PORT}
Environment=DB_PATH=${APP_DIR}/botpult.db
ExecStart=/usr/bin/node ${APP_DIR}/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now botpult

# 7. Настройка домена и выпуск SSL-сертификата
echo -e "\n${YELLOW}[6/6] Настройка адреса и защищённого HTTPS-соединения...${NC}"
SERVER_IP=$(curl -4 -fsS --max-time 8 https://api.ipify.org || hostname -I | awk '{print $1}')

echo -e "Если у вас есть свой домен (с A-записью на IP ${CYAN}${SERVER_IP}${NC}), введите его ниже."
echo -e "Если домена нет — просто нажмите ${GREEN}Enter${NC}, и адрес создастся автоматически."
USER_DOMAIN=""
if [ -r /dev/tty ]; then
  read -r -p "Ваш домен (или Enter для авто-адреса): " USER_DOMAIN < /dev/tty || true
fi

USER_DOMAIN=$(echo "$USER_DOMAIN" | tr -d '[:space:]' | sed -E 's#^https?://##; s#/.*$##')

if [ -n "$USER_DOMAIN" ]; then
  TARGET_DOMAIN="$USER_DOMAIN"
else
  DASH_IP=$(echo "$SERVER_IP" | tr '.' '-')
  TARGET_DOMAIN="${DASH_IP}.sslip.io"
  echo -e "Автоматически назначен защищённый адрес: ${GREEN}${TARGET_DOMAIN}${NC}"
fi

cat <<EOF > /etc/caddy/Caddyfile
${TARGET_DOMAIN} {
    encode gzip
    reverse_proxy 127.0.0.1:${APP_PORT}
}
EOF

systemctl enable --now caddy
systemctl reload caddy || systemctl restart caddy

sleep 3

echo -e "\n${GREEN}====================================================${NC}"
echo -e "${GREEN}   BotPult успешно установлен и запущен!            ${NC}"
echo -e "${GREEN}====================================================${NC}"
echo -e "Ссылка на админ-панель:  ${CYAN}https://${TARGET_DOMAIN}/panel${NC}"
echo -e "Логин / Пароль по умолч.: ${YELLOW}admin${NC} / ${YELLOW}05051983${NC}"
echo -e "Папка программы и базы:   ${APP_DIR} (файл базы: botpult.db)"
echo -e "----------------------------------------------------"
echo -e "Полезные команды управления:"
echo -e "  Статус бота:       systemctl status botpult"
echo -e "  Перезапуск бота:   systemctl restart botpult"
echo -e "  Смена домена:      nano /etc/caddy/Caddyfile && systemctl reload caddy"
echo -e "${GREEN}====================================================${NC}\n"