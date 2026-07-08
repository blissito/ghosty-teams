#!/usr/bin/env bash
# Rebake del template inmutable `ghosty-chat` (ARCHITECTURE §6). PROBADO 2026-07-05.
#
# Pipeline real (2 repos + host OVH KS-5):
#   ~/ghosty-chat (source)  →  ~/sandbox-host/templates/ghosty-chat/app  →  host: docker build → ext4
#
# El bake produce un rootfs ext4 de Firecracker → SOLO corre en el host Linux
# (docker + mkfs.ext4 + loop mount + sandbox-agent), no en la Mac. Este script
# sincroniza el source, sube el template al host y hornea allá. NO recrea VMs
# (eso es vía EasyBits/provisioner) ni inyecta secrets (van en /app/secrets.env
# al provisionar). Las VMs corriendo NO se afectan: usan su ext4 ya cargado.
#
# Uso:  ./scripts/rebake.sh
# Vars: HOST (54.38.94.14) · KEY (~/.ssh/id_rsa_ovh) · SBHOST (~/sandbox-host) · SIZE (4096) · SKIP_BUILD=1
set -euo pipefail

HOST="${HOST:-54.38.94.14}"
KEY="${KEY:-$HOME/.ssh/id_rsa_ovh}"
SBHOST="${SBHOST:-$HOME/sandbox-host}"
SIZE="${SIZE:-4096}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SSH="ssh -i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR"
APP="$SBHOST/templates/ghosty-chat/app"

# 1) Sanity local.
if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  echo "▸ [1/6] Build local (sanity)…"; ( cd "$REPO" && npx tsc --noEmit && npm run build >/dev/null ); echo "  ✓"
fi

# 2) Sync source → template app/. OJO: NO copiar package-lock.json — un lockfile
#    de macOS hace que `npm install` en linux-amd64 omita los binarios nativos
#    (rolldown/oxide) → build roto. package.json usa 'latest', se resuelve fresco.
echo "▸ [2/6] Sync source → $APP"
rsync -a --delete \
  --include='src/***' --include='public/***' \
  --include='package.json' \
  --include='vite.config.ts' --include='tsconfig.json' --include='tsr.config.json' \
  --exclude='*' "$REPO/" "$APP/"
rm -f "$APP/package-lock.json"

# 3) Subir template + build_template.sh al host.
echo "▸ [3/6] rsync template → host"
rsync -az --delete -e "$SSH" "$SBHOST/templates/ghosty-chat/" "root@$HOST:/root/templates/ghosty-chat/"
rsync -az -e "$SSH" "$SBHOST/scripts/build_template.sh" "root@$HOST:/root/build_template.sh"

# 4) docker build en el host (npm install + npm run build en el contenedor amd64).
echo "▸ [4/6] docker build (host)…"
$SSH "root@$HOST" "cd /root/templates/ghosty-chat && rm -f app/package-lock.json && docker build --provenance=false --sbom=false -t localhost/ghosty-chat:latest . 2>&1 | tail -5"

# 5) Respaldo del ext4 vivo (el bake NO es atómico: rm -f antes de reconstruir) + bake.
echo "▸ [5/6] backup + build_template.sh (host)…"
$SSH "root@$HOST" "set -e
  D=\$(date +%Y%m%d-%H%M)
  cp -f /var/lib/sandbox-host/templates/ghosty-chat.ext4 /var/lib/sandbox-host/templates/ghosty-chat.ext4.bak-\$D
  AGENT_BIN=/usr/local/bin/sandbox-agent bash /root/build_template.sh ghosty-chat localhost/ghosty-chat:latest $SIZE 2>&1 | tail -4"

# 6) Refresca el LOOP BASE del template. CRÍTICO: el bake hace `rm -f`+recrea el
#    ext4 (nuevo inode), pero `ensureBaseLoop` (dmsnapshot.go) cachea UN loop RO por
#    template en memoria del daemon y lo reusa mientras el /dev/loopN exista → todo
#    box nuevo forkea CoW del ext4 VIEJO (loop backed por inode "(deleted)"). Sin
#    esto el rebake NO tiene efecto aunque el ext4 en disco sea nuevo. Fix: matar los
#    boxes ghosty-chat (liberan el snapshot), detachar el loop base huérfano y
#    reiniciar el daemon (limpia el cache; Reconcile re-adopta las VMs vivas → 0 loss).
echo "▸ [6/7] refrescar loop base + reciclar boxes (host)…"
$SSH "root@$HOST" 'bash -s' <<'REFRESH'
set -uo pipefail
TOK=$(grep -oP '^SANDBOX_HOST_TOKEN=\K.*' /etc/sandbox-host/.env); API=http://127.0.0.1:8080
# 1) matar todos los boxes ghosty-chat (DELETE hace teardown del dm CoW)
for SB in $(python3 -c "import json; d=json.load(open('/var/lib/sandbox-host/store.json')); it=d.items() if isinstance(d,dict) else enumerate(d); [print(v['sandboxId']) for k,v in it if v.get('template')=='ghosty-chat']"); do
  curl -s -o /dev/null -X DELETE -H "Authorization: Bearer $TOK" "$API/v1/sandbox/$SB"; echo "  killed $SB"
done
sleep 2
# 2) detachar cualquier loop respaldado por el ext4 borrado del template
losetup -a | grep -E 'ghosty-chat\.ext4 \(deleted\)' | cut -d: -f1 | while read -r LP; do
  losetup -d "$LP" 2>/dev/null && echo "  detached stale $LP" || echo "  $LP busy (skipped)"
done
# 3) reiniciar el daemon → limpia baseLoops en memoria; Reconcile re-adopta vivas
systemctl restart sandbox-host; sleep 3
echo -n "  daemon: "; systemctl is-active sandbox-host
journalctl -u sandbox-host --no-pager -n 3 --since '8 seconds ago' | grep -i reconcile || true
REFRESH

# 7) Smoke: VM efímera del template → systemd active + server en :3000 (500 sin
#    secrets es OK; prueba que bootea y la app corre). Se borra al final.
echo "▸ [7/7] smoke test (host)…"
$SSH "root@$HOST" 'bash -s' <<'SMOKE'
set -uo pipefail
TOK=$(grep -oP '^SANDBOX_HOST_TOKEN=\K.*' /etc/sandbox-host/.env); API=http://127.0.0.1:8080
SID=$(curl -s -X POST "$API/v1/sandbox" -H "Authorization: Bearer $TOK" -H "X-Easybits-Owner: smoke" -H "Content-Type: application/json" -d '{"template":"ghosty-chat","timeoutSeconds":180,"name":"smoke"}' | jq -r .sandboxId)
trap 'curl -s -X DELETE "$API/v1/sandbox/$SID" -H "Authorization: Bearer $TOK" >/dev/null' EXIT
for i in $(seq 1 30); do [ "$(curl -s -H "Authorization: Bearer $TOK" "$API/v1/sandbox/$SID" | jq -r .status)" = running ] && break; sleep 2; done
sleep 6
curl -s -X POST "$API/v1/sandbox/$SID/exec" -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
  -d '{"command":"systemctl is-active ghosty-chat; curl -s -o /dev/null -w \"http=%{http_code}\\n\" http://127.0.0.1:3000/","timeoutSeconds":30}' | jq -r '.stdout // .'
SMOKE

echo; echo "✓ Rebake completado. Las VMs nuevas nacen con este template; recrea las"
echo "  existentes vía EasyBits/provisioner si quieres migrarlas ya."
