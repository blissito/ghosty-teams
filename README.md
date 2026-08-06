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
- 📄 **Documentos vivos** — editor, versiones, corrector de ortografía propio y
  export a `.docx` / PDF / `.xlsx`.
- 🔌 **Integraciones per-user** (OAuth2) — GitHub, Sentry, Deník, Calendly. Las tools
  corren con **tus** credenciales, nunca con las de otro.
- 🐙 **Revisión de PRs desde el chat** — el agente lee el diff y el log de CI, deja
  comentarios anclados a la línea, y cierra con una tarjeta de
  **Aprobar · Pedir cambios · Rechazar · Mergear** que se ejecuta con la cuenta de
  quien hace clic. Los PRs que abre salen a nombre de `ghosty-studio[bot]`, así que
  cualquiera del equipo puede aprobarlos.

## Cómo funciona

- **Identidad** → login de Ghosty; cada workspace vive en su subdominio
  (`<slug>.teams.ghosty.studio`) y el ingress está **gateado por membresía**.
- **Un solo proceso, muchos tenants.** No hay una microVM por equipo: la app corre en
  una caja multitenant y el aislamiento es por **namespace de sqld**, resuelto desde
  el host de cada request (`currentNamespace()`). Lo que sí es por tenant es la DB.
- **Los agentes** → `@ghosty` y compañía corren en la flota de Ghosty Studio, con su
  propio runtime; Teams les habla por HMAC de partner.
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
