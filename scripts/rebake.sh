#!/usr/bin/env bash
# Rebake del template inmutable `ghosty-chat` (ARCHITECTURE §6).
#
# El app corre en microVMs Firecracker desde un template ext4 horneado EN el
# host OVH KS-5. Este script automatiza: build local (sanity) → rsync del código
# al host → docker build → build_template.sh. NO crea/recrea VMs (eso es vía la
# API de EasyBits / provisioner de Formmy) ni inyecta secrets (se reinyectan al
# provisionar). Idempotente y seguro de re-correr.
#
# Uso:
#   HOST=mi-alias-ovh ./scripts/rebake.sh
# Variables:
#   HOST        (requerida) alias/host SSH del OVH KS-5.
#   REMOTE_DIR  (opcional)  dir del template en el host. Default: templates/ghosty-chat
#   SKIP_BUILD  (opcional)  =1 para saltar el `npm run build` local.
set -euo pipefail

HOST="${HOST:-}"
REMOTE_DIR="${REMOTE_DIR:-templates/ghosty-chat}"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [[ -z "$HOST" ]]; then
  echo "✗ Falta HOST. Uso: HOST=mi-alias-ovh ./scripts/rebake.sh" >&2
  exit 1
fi

echo "▸ Repo:   $REPO_DIR"
echo "▸ Host:   $HOST:$REMOTE_DIR"
echo

# 1) Sanity local: que compile y buildee antes de subir nada.
if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  echo "▸ [1/4] Build local (sanity)…"
  ( cd "$REPO_DIR" && npx tsc --noEmit && npm run build >/dev/null )
  echo "  ✓ tsc limpio + build OK"
else
  echo "▸ [1/4] Build local OMITIDO (SKIP_BUILD=1)"
fi

# 2) Sync del código al host. Solo el source + manifiestos; NADA de secrets,
#    .output, node_modules ni la DB local (el bake instala deps en el Dockerfile).
echo "▸ [2/4] rsync → $HOST:$REMOTE_DIR/app/"
rsync -az --delete \
  --include='src/***' \
  --include='public/***' \
  --include='package.json' --include='package-lock.json' \
  --include='vite.config.ts' --include='tsconfig.json' --include='tsr.config.json' \
  --exclude='*' \
  "$REPO_DIR/" "$HOST:$REMOTE_DIR/app/"
echo "  ✓ código sincronizado"

# 3) Bake remoto: imagen docker → template ext4.
echo "▸ [3/4] docker build + build_template.sh (remoto)…"
ssh "$HOST" "cd '$REMOTE_DIR' && \
  docker build --provenance=false --sbom=false -t ghosty-chat . && \
  ./build_template.sh"
echo "  ✓ template ghosty-chat horneado"

# 4) Recordatorio manual (no automatizado a propósito).
echo
echo "▸ [4/4] Falta a mano:"
echo "   • Crear/recrear VM desde el template (API EasyBits / provisioner). El"
echo "     provisioning reinyecta /app/secrets.env — no se hornean secrets."
echo "   • Smoke test: GET https://teams.formmy.app/api/stream con cookie gc_session"
echo "     → devuelve text/event-stream y llegan eventos entre dos sesiones."
echo
echo "✓ Rebake completado."
