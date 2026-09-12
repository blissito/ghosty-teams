// ── La guía de uso de Ghosty Teams, como NOTA de la memoria del workspace ────────────
//
// Vive aquí y no en una skill ni en el prompt por turno: en la memoria la ve el equipo
// (página Memoria) y la lee el agente con `memory_read` cuando le preguntan cómo se usa
// algo. Se siembra en cada workspace al arrancar (`ensureSchema` → `seedTeamsGuide`) y se
// actualiza sola cuando cambia este archivo: la fila se reconoce por `source_ref`.
//
// ⚠️ Sólo lo que EXISTE. Una función inventada aquí la repetirá el agente con toda
// confianza. Si dudas, quítalo.
export const GUIA_TEAMS_SOURCE_REF = "sys:guia-teams";
export const GUIA_TEAMS_TITLE = "Cómo usar Ghosty Teams (guía oficial)";

export const GUIA_TEAMS_NOTE = `Guía de uso de Ghosty Teams. Léela completa cuando alguien pregunte cómo hacer algo en la app; responde con el paso exacto y no inventes pantallas que no estén aquí.

## Hablar con el agente
- @mención en cualquier canal o hilo: responde ahí mismo. Es la vía universal.
- Mensaje directo: clic en el nombre del agente → "Mensaje directo", o el (+) de Mensajes directos.
- /clear en una conversación: el agente olvida el hilo y empieza de cero (la memoria guardada NO se borra).
- Nota de voz: el micrófono del cuadro de texto graba; soltar es enviar. La plataforma transcribe.

## Canales, hilos y llamadas
- Rooms (canales) agrupan conversaciones; los hilos cuelgan de un mensaje; se puede citar un mensaje.
- Llamadas de audio/video desde el botón "Llamada" del encabezado del room; se pueden grabar y la grabación queda en el room.

## Tareas
- Tablero del workspace en "Tareas" (barra lateral). Se le pide al agente en el chat: "crea la tarea X y asígnala a Ana"; la tarjeta aparece en el tablero y se puede mover de estado desde el chat.

## Documentos y artefactos
- Lo que el agente produce (documentos, hojas de cálculo, apps HTML, imágenes) se abre en el panel lateral. Se exporta a .docx, PDF o .xlsx y se comparte por link.
- Un artefacto se edita desde la conversación donde nació. "Documentos" en la barra lateral lista los del workspace.

## Formularios
- "Formularios" en la barra lateral, o pedírselo al agente: arma un formulario público para recabar datos de alguien sin cuenta; las respuestas llegan al workspace.

## Memoria
- "Memoria": hechos de la empresa que todos los agentes consultan (esta guía es una nota más). Se agregan a mano o soltando un documento para que el agente lo destile.
- En un room, los lineamientos ("los títulos van en ##") se guardan como memoria del room y rigen ahí.

## Recordatorios
- Pedírselos al agente: "recuérdame el jueves a las 10 mandar el contrato". Avisan en la conversación donde se pidieron.

## Integraciones (Ajustes → Integraciones)
- Son PERSONALES: cada persona conecta su cuenta (GitHub, Gmail, Calendario, Sentry, Odoo…). El agente actúa con la cuenta de quien le escribe.
- Una integración se puede compartir con el equipo desde ese mismo panel.
- GitHub, en 2 pasos: (1) conectar la cuenta en Ajustes → Integraciones; (2) en el room, botón de GitHub del encabezado → elegir los repositorios de ese room. Sin el paso 2 el agente no tiene herramientas de GitHub en ese room. En un mensaje directo no hay ese límite.
- Con GitHub el agente lee código, revisa PRs (tarjeta con Aprobar / Pedir cambios / Mergear que ejecuta quien hace clic, con su cuenta), abre issues y pull requests (los PRs los firma el bot ghosty-studio[bot]) y lee los logs de un workflow rojo.

## Prospección (beta)
- "Prospección": buscar negocios, enriquecerlos por columna y abrirles conversación por correo o WhatsApp. Está en desarrollo: revisar cada envío antes de mandarlo.

## Agentes (Ajustes → Agentes)
- "Personalidad en este espacio": tono y reglas sólo para este workspace. El prompt base y el modelo se configuran en Ghosty Studio y aplican en todos los espacios.
- Cambiar de modelo reinicia al agente; las conversaciones abiertas siguen con el modelo anterior hasta /clear.

## Uso y plan
- "Uso" (menú del workspace) muestra el saldo del mes por agente y hasta cuándo está pagado el plan. Con llave propia del proveedor (BYOK, en Ghosty Studio → Credenciales) el consumo no descuenta de la bolsa.
`;
