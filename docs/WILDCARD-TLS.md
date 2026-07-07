# Wildcard TLS para las sandboxes — incidente + fix (2026-07-07)

## Síntoma
teams.formmy.app eterno en "Levantando tu team…" / ECONNRESET. Las boxes estaban
**sanas por dentro** (`curl localhost:3000` → 307) pero **inalcanzables por HTTPS**
(`http=000`, timeout).

## Causa raíz
Caddy (host OVH `54.38.94.14`) servía `*.sandboxes.easybits.cloud` con **TLS on-demand**:
pedía **un cert de Let's Encrypt por hostname de box** (`sb-<id>-<port>.sandboxes…`).
Como cada revive crea una box con hostname nuevo y las viejas no se destruyen, el churn
reventó el **rate-limit de Let's Encrypt: 50 certs/semana por dominio registrado
(`easybits.cloud`)** → HTTP 429 → Caddy no obtenía cert → el handshake TLS colgaba.

Diagnóstico clave en el log de Caddy:
```
could not get certificate ... HTTP 429 too many certificates (50) already issued
for "easybits.cloud" in the last 168h, retry after 2026-07-07 19:05:51 UTC
```

## Fix (permanente): un cert WILDCARD
`*.sandboxes.easybits.cloud` = **un solo cert para TODAS las boxes**. Cuando Caddy tiene
un cert que matchea el SNI, lo usa y **deja de disparar el on-demand de LE**. Cero emisión
por-box → imposible volver a chocar el límite.

- **CA:** ZeroSSL (ACME, límites independientes de LE → funcionó aunque LE estuviera 429).
- **Challenge:** DNS-01 sobre **Route53** (zona `easybits.cloud` = `Z08557901CRRK53IDZK75`).
- **Creds Route53:** IAM `pulso_easybits` (cuenta AWS 476114113638). ⚠️ Las de los `.env`
  de easybits/formmy son de **Tigris/S3** (no AWS real). La que sirve estaba en `~/mailmask/.env`.
  acme.sh las guarda en `/root/.acme.sh/account.conf` para renovar.
- **Emisor/herramienta:** `acme.sh` en el host (`/root/.acme.sh`).

### Lo que quedó montado en el host OVH
1. **Cert** en `/etc/caddy/certs/sandboxes.{crt,key}` (owner `caddy`, key `640`).
   Emitido con: `acme.sh --issue --server zerossl --dns dns_aws -d '*.sandboxes.easybits.cloud'`
   e instalado con `acme.sh --install-cert … --reloadcmd 'chown caddy … ; systemctl reload caddy'`.
2. **Caddyfile** (`/etc/caddy/Caddyfile`) — el bloque `*.sandboxes.easybits.cloud` cambió
   `tls { on_demand }` → `tls /etc/caddy/certs/sandboxes.crt /etc/caddy/certs/sandboxes.key`.
   (El `https://` catch-all de dominios custom SIGUE con on-demand — es bajo volumen y legítimo.)
   Backup: `/etc/caddy/Caddyfile.bak-<fecha>`.
3. **Renovación:** systemd timer `acme-renew.timer` (diario) → `acme.sh --cron` → renueva vía
   Route53 y corre el reloadcmd (recarga Caddy). El host NO tenía crontab, por eso timer.
   Cert vence 2026-10-05; renueva ~2026-09-22.

### Verificación
```
openssl s_client -connect <box>-3000.sandboxes.easybits.cloud:443 -servername <mismo> \
  | openssl x509 -noout -issuer   # → issuer=ZeroSSL ECC DV
curl -so /dev/null -w '%{http_code}' https://<box>-3000.sandboxes.easybits.cloud/  # → 307 (box viva)
```
`404` = TLS OK pero la box no está viva/expuesta (idle-suspend/expirada) → el ingress la
resume/revive en el próximo request. NO es problema de cert.

### Verificado (2026-07-07)
- **Cubre a TODOS los users:** el wildcard matchea CUALQUIER `sb-<id>-<port>.sandboxes.easybits.cloud`
  de cualquier team/owner. No es por-usuario → ningún user vuelve a depender de emitir un cert.
  Probado: box de fixtergeek (sin cert previo) → 307; hostname de otro owner → TLS también resuelve
  por el wildcard. Bonus: más rápido (sin mint on-demand en el primer request de cada box).
- **Renovación probada DESATENDIDA:** `acme.sh --renew --force` SIN creds en env (igual que el timer)
  → renovó vía Route53 (creds en `account.conf` = `SAVED_AWS_ACCESS_KEY_ID`) + recargó Caddy + cert
  nuevo. Se limpió el `Le_DeployHook` viejo (daba un "Error deploying" cosmético) → `acme.sh --cron`
  corre en verde. Timer `acme-renew.timer` diario, próxima renovación real ~2026-09-22.
- **Excepción (ok):** dominios custom CNAME (`app.cliente.com`) siguen on-demand en el bloque
  `https://` — camino aparte, bajo volumen, no toca el límite.

## Rollback
`cp /etc/caddy/Caddyfile.bak-<fecha> /etc/caddy/Caddyfile && systemctl reload caddy`
(vuelve a on-demand). `acme.sh --remove -d '*.sandboxes.easybits.cloud'` para soltar el cert.

## Deuda pendiente (NO urgente, ya no rompe nada)
- **Churn de boxes / `5/4 sandboxes`:** el revive crea boxes nuevas sin destruir las viejas y el
  resume-first solo aplica si `status==suspended`. Fix en `formmy_rrv7/server/server.ts` `reviveBox`:
  destruir la box previa al crear una nueva + resume-first robusto. Con el wildcard ya no quema
  certs, pero sigue consumiendo cuota/recursos. Ver el runbook `teams-revive-recovery`.
- **Idea futura (mejor aún):** hostname **estable por-team** (`<team>.sandboxes…`, la máquina
  detrás cambia) → URL fija + 1 cert/team; o ruteo por-path `/<id>` (1 hostname, requiere que la
  app sea base-path-aware). Con el wildcard ninguna es urgente.
