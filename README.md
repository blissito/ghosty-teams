<p align="center">
  <img src="public/ghosty-512.png" width="130" alt="Ghosty" />
</p>

<h1 align="center">Ghosty Teams</h1>

<p align="center">
  <b>Slack, pero le tageas una IA.</b><br/>
  Chat de equipo con <code>@ghosty</code> — multitenant y cloud-native.
</p>

<p align="center">
  <a href="https://easybits.cloud">☁️ EasyBits</a> ·
  <a href="https://formmy.app">🔑 Formmy</a> ·
  <a href="LICENSE">BUSL 1.1</a>
</p>

---

Rooms + hilos estilo Slack, y **tageas a un agente** (`@ghosty` o los tuyos) para
que responda en la conversación. Cada equipo corre en su propia instancia con
estado aislado.

- 🧵 **Rooms + hilos** — flujo libre; los hilos nacen de un mensaje.
- 🤖 **`@ghosty` + multi-agente** — agentes de tu flota o bots por webhook, cada
  uno por su `@handle`, con feed de actividad.
- 🔔 **Menciones + Web Push** · 📱 **PWA** instalable · ⚡ optimista y animado.

## Cómo funciona

- **[Formmy](https://formmy.app)** → identidad + enruta a tu equipo desde el
  dominio estable `teams.formmy.app` (ingress **gateado por membresía**: solo
  entras a la caja de un team del que eres miembro).
- **[EasyBits](https://easybits.cloud)** → cada equipo levanta su microVM
  (Firecracker) + su DB aislada; `@ghosty` es un agente de tu flota (OAuth2).
- **La app** → [TanStack Start](https://tanstack.com/start) (React 19 SSR) +
  Tailwind. Compute stateless, historial durable.

Detalle en [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Local

```bash
npm install && npm run dev
```

## Licencia

[**BUSL 1.1**](LICENSE) — autohospedar para tu propio equipo es **gratis**
(incluso en EasyBits hosting); multitenant/reventa requiere licencia comercial.

<p align="center">
  Hecho por <a href="https://fixter.org">Fixter</a> · con
  <a href="https://easybits.cloud">EasyBits</a> +
  <a href="https://formmy.app">Formmy</a>
</p>
