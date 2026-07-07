#!/usr/bin/env bash
# ── Wildcard TLS para *.sandboxes.easybits.cloud ────────────────────────────
# Arregla de raíz el "no levanta" por rate-limit de Let's Encrypt: hoy Caddy pide
# UN cert por hostname de box (TLS on-demand) → el churn de boxes revienta el límite
# de LE (50 certs/semana por easybits.cloud) → HTTPS cuelga → team inalcanzable.
#
# La cura: UN solo cert WILDCARD `*.sandboxes.easybits.cloud`. Cuando Caddy tiene un
# cert que matchea el SNI, lo usa y DEJA de disparar el on-demand de LE. Cero emisión
# por-box, nunca más se toca el límite. Aditivo y reversible (quitar el cert del pool).
#
# Emisor: ZeroSSL (CA ACME distinta a LE, límites independientes → funciona AUNQUE LE
# esté rate-limited). Challenge: DNS-01 sobre Route53 (la zona easybits.cloud vive ahí).
# Renovación: acme.sh instala su propio cron y re-deploya a Caddy solo → nunca caduca.
#
# CORRE EN EL HOST OVH (donde vive Caddy). Uso:
#   export AWS_ACCESS_KEY_ID=...        # IAM con permiso Route53 sobre la zona easybits.cloud
#   export AWS_SECRET_ACCESS_KEY=...    #   (route53:ChangeResourceRecordSets + ListHostedZones + GetChange)
#   export ACME_EMAIL=fixtergeek@gmail.com
#   bash wildcard-sandboxes-cert.sh
#
# ⚠️ Las creds de los .env del proyecto son de Tigris/S3 (no AWS real) → NO sirven aquí.
#    Hace falta una IAM key real con acceso a Route53. Política mínima al final de este archivo.
set -euo pipefail

DOMAIN="*.sandboxes.easybits.cloud"
ACME_EMAIL="${ACME_EMAIL:-fixtergeek@gmail.com}"
CADDY_ADMIN="${CADDY_ADMIN:-http://localhost:2019}"

: "${AWS_ACCESS_KEY_ID:?exporta AWS_ACCESS_KEY_ID con acceso Route53}"
: "${AWS_SECRET_ACCESS_KEY:?exporta AWS_SECRET_ACCESS_KEY}"

echo "▸ [1/5] Instalar acme.sh (si falta)…"
if [ ! -f "$HOME/.acme.sh/acme.sh" ]; then
  curl -s https://get.acme.sh | sh -s email="$ACME_EMAIL"
fi
ACME="$HOME/.acme.sh/acme.sh"

echo "▸ [2/5] Registrar cuenta ZeroSSL (EAB auto por email)…"
"$ACME" --register-account -m "$ACME_EMAIL" --server zerossl || true

echo "▸ [3/5] Emitir wildcard $DOMAIN vía ZeroSSL + Route53 DNS-01…"
# dns_aws usa AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY (Route53). --dnssleep deja
# propagar el TXT. Idempotente: si ya existe y es válido, no re-emite.
AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY" \
  "$ACME" --issue --server zerossl --dns dns_aws -d "$DOMAIN" --dnssleep 30 || \
  { [ "$?" = "2" ] && echo "  (ya vigente, nada que renovar)"; }

echo "▸ [4/6] Instalar cert en ruta estable + reloadcmd (perms para el user 'caddy')…"
# El deploy-hook 'caddy' de acme.sh NO está en todas las builds → usamos --install-cert
# a una ruta fija que el Caddyfile referencia. El reloadcmd re-copia+recarga en cada
# renovación (arregla perms que --install-cert resetea a root).
mkdir -p /etc/caddy/certs
"$ACME" --install-cert -d "$DOMAIN" --ecc \
  --key-file /etc/caddy/certs/sandboxes.key \
  --fullchain-file /etc/caddy/certs/sandboxes.crt \
  --reloadcmd 'chown caddy:caddy /etc/caddy/certs/sandboxes.crt /etc/caddy/certs/sandboxes.key; chmod 640 /etc/caddy/certs/sandboxes.key; systemctl reload caddy'
chown caddy:caddy /etc/caddy/certs/sandboxes.crt /etc/caddy/certs/sandboxes.key; chmod 640 /etc/caddy/certs/sandboxes.key

echo "▸ [5/6] Caddyfile: en el bloque *.sandboxes.easybits.cloud cambia 'tls { on_demand }'"
echo "        por 'tls /etc/caddy/certs/sandboxes.crt /etc/caddy/certs/sandboxes.key'."
echo "        (Edición MANUAL — respeta el reverse_proxy 127.0.0.1:8082 y el https:// catch-all.)"
echo "        Backup + validar + recargar:"
echo "          cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-\$(date +%Y%m%d-%H%M)"
echo "          caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy"

echo "▸ [6/6] Renovación automática (el host no tiene crontab → systemd timer)…"
cat > /etc/systemd/system/acme-renew.service <<EOF
[Unit]
Description=acme.sh renew certs ($DOMAIN)
After=network-online.target
[Service]
Type=oneshot
ExecStart=$HOME/.acme.sh/acme.sh --cron --home $HOME/.acme.sh
EOF
cat > /etc/systemd/system/acme-renew.timer <<'EOF'
[Unit]
Description=Daily acme.sh cert renewal
[Timer]
OnCalendar=*-*-* 03:17:00
RandomizedDelaySec=1h
Persistent=true
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload && systemctl enable --now acme-renew.timer
echo
echo "✓ Listo. Caddy sirve TODAS las *.sandboxes.easybits.cloud con el wildcard; on-demand LE inerte."
echo "  Renovación: systemd timer acme-renew.timer (diario). Nunca más depende de certs nuevos."
echo "  Rollback: cp /etc/caddy/Caddyfile.bak-* /etc/caddy/Caddyfile && systemctl reload caddy;"
echo "            $ACME --remove -d '$DOMAIN'."
#
# ── Política IAM mínima para la key de Route53 ──────────────────────────────
# {
#   "Version": "2012-10-17",
#   "Statement": [
#     { "Effect": "Allow", "Action": ["route53:GetChange"], "Resource": "arn:aws:route53:::change/*" },
#     { "Effect": "Allow", "Action": ["route53:ListHostedZones","route53:ListHostedZonesByName"], "Resource": "*" },
#     { "Effect": "Allow", "Action": ["route53:ChangeResourceRecordSets","route53:ListResourceRecordSets"],
#       "Resource": "arn:aws:route53:::hostedzone/<ZONE_ID_DE_easybits.cloud>" }
#   ]
# }
