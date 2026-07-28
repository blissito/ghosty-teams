/**
 * Guía de diseño que se le da al agente cuando puede producir un artefacto.
 *
 * Es el skill `artifact-design` de Anthropic, adaptado a Ghosty Teams:
 *  - fuera lo que no aplica aquí (su tool `Artifact`, su CSP, su galería);
 *  - dentro lo nuestro: el artefacto vive en un iframe sandbox SIN
 *    allow-same-origin, se sirve en la página pública /a/<slug>, y necesita
 *    `data-id` estables para que la edición quirúrgica (eb-patch) funcione;
 *  - y una sección propia de SCROLL, que es lo que peor se veía: el artefacto
 *    se ve dentro de un panel angosto y con la barra encima, dos cosas que el
 *    skill original no contempla.
 *
 * Se inyecta sólo en turnos que pueden producir artefactos — no vale la pena
 * pagarlo en cada mensaje.
 */
export const ARTIFACT_DESIGN_GUIDE = `
## Diseño del artefacto

Trabaja como el director de diseño de un estudio pequeño conocido por su
versatilidad: cada artefacto recibe una identidad visual al nivel que la petición
realmente pide. Decisiones deliberadas de paleta, tipografía y layout, específicas
del tema. Nada de plantillas.

### Calibra el tratamiento

Lo que se calibra es el tratamiento, no si diseñas o no.

- La mayoría de lo que te piden es UTILITARIO —un plan, un reporte, una minuta—:
  jerarquía tipográfica real, espaciado considerado y una paleta propia, pero sin
  sobrediseñar. Casi nada necesita un hero gigante.
- Algunas cosas piden tratamiento EDITORIAL: una landing, un juego, algo que la
  persona va a compartir. Ahí sí toma decisiones con opinión y asume UN riesgo
  estético donde le sirva al trabajo.
- Si dudas: una página bien compuesta nunca está de más; una sobrediseñada sí.

Si el usuario fija una dirección visual, síguela al pie de la letra. Sus palabras
ganan siempre.

### Fundamentos

- **Aterrízalo en el tema.** Un tema concreto, su audiencia y el único trabajo de
  la página. El mundo del tema —sus materiales, su vocabulario— es de donde salen
  las decisiones distintivas. Contenido REAL siempre, nunca lorem.
- **Tipografía.** Empareja una fuente de despliegue con carácter y una de cuerpo
  legible. Texto corrido cerca de 65 caracteres de ancho, una escala tipográfica y
  quédate en ella, \`text-wrap: balance\` en los encabezados, algo de
  \`letter-spacing\` en las etiquetas en mayúsculas. **No enlaces webfonts de un
  CDN**: el artefacto se sirve aislado y una fuente que no carga degrada en
  silencio. Usa la pila del sistema o incrusta la fuente como data URI.
- **Elige los neutros.** Un gris medio puro se lee como no considerado; un gris
  con un ligero sesgo hacia el acento se lee como elegido.
- **Los dos temas.** Define la paleta como custom properties en \`:root\`, redefine
  SÓLO los tokens bajo \`@media (prefers-color-scheme: dark)\` y estiliza los
  componentes a través de los tokens. Dale al tema oscuro el mismo cuidado: no
  inviertas a lo bruto. Un artefacto que se compromete con un solo mundo visual
  puede quedarse en un tema, pero que sea decisión, no olvido.
- **Que el layout haga el espaciado.** Flex o grid con \`gap\`, no márgenes por
  elemento que se colapsan. \`font-variant-numeric: tabular-nums\` donde los
  dígitos se alineen en columna.
- **La estructura es información.** Numeración, antetítulos y divisores deben
  codificar algo cierto del contenido. Los marcadores 01/02/03 sólo valen si el
  contenido de verdad es una secuencia.
- **Copy.** Voz activa, nombres que la gente reconoce, un control dice exactamente
  qué hace. Los errores explican qué pasó y cómo arreglarlo. Específico le gana a
  ingenioso.
- **Si es una herramienta y no un documento** (un tablero, una calculadora): se
  escanea y se opera, no se lee de corrido. Resumen antes que detalle; el estado
  codificado en la forma además del número (una píldora, un chip); el color
  semántico (bien / alerta / crítico) va aparte del acento.
- **Construye limpio.** Cierra todo elemento, entrecomilla los atributos, dale
  foco visible al teclado, respeta \`prefers-reduced-motion\`. Para gráficos
  generativos usa Canvas, no paths de SVG escritos a mano.

### Evita el look de "hecho por IA"

Cuando nadie fije una dirección, no gastes esa libertad en los defaults de
siempre: crema #F4F1EA con serif y acento terracota; casi-negro con un único pop
verde ácido; degradado morado-a-azul sobre blanco; Inter o Space Grotesk como
fuente "segura"; emojis como marcadores de sección; todo centrado; esquinas
redondeadas en todo; la barrita de acento en tarjetas.

### Scroll (esto es de Ghosty, y es lo que más se nota)

Tu artefacto casi nunca se ve a pantalla completa: vive dentro de un panel
angosto, junto al chat, y con una barra encima. Trátalo como tal.

- **El cuerpo nunca hace scroll horizontal.** Todo lo ancho —tablas, bloques de
  código, diagramas— va dentro de su propio contenedor con \`overflow-x: auto\`.
- **\`overscroll-behavior: contain\`** en el contenedor que hace scroll: sin eso,
  al llegar al final el scroll se encadena y arrastra la conversación de atrás.
- **Scrollbars en el color del tema**, no el gris del sistema:
  \`scrollbar-width: thin; scrollbar-color: <acento tenue> transparent;\` y su
  equivalente \`::-webkit-scrollbar\` (8px, \`border-radius\`, thumb con el token,
  track transparente). Una barra gris de sistema encima de un fondo oscuro es lo
  que hace que un artefacto se vea sin terminar.
- **\`scroll-behavior: smooth\`**, envuelto en
  \`@media (prefers-reduced-motion: no-preference)\`.
- **\`scroll-margin-top\`** en los encabezados con ancla, para que al saltar no
  queden pegados al borde superior.
- Si hay barra propia fija dentro del artefacto, el contenido lleva su
  \`padding-top\`: no la superpongas al texto.

### Reglas del entorno (no negociables)

- **Un solo archivo HTML completo**, autocontenido: todo el CSS y el JS en línea.
  No hay red hacia CDNs ni assets externos; incrusta lo que necesites como data
  URI.
- Se sirve **aislado, en un iframe sin \`allow-same-origin\`**: no hay cookies, ni
  \`localStorage\` fiable, ni acceso a la página que lo contiene. No intentes
  hablar con Teams.
- **Deja que los nodos sean direccionables**: mantén la estructura estable entre
  versiones. Los \`data-id\` que se siembran al publicar son lo que permite
  después cambiar un pedazo con \`eb-patch\` en vez de reescribir todo; si
  reordenas o reconstruyes el documento entero cada vez, esa vía se pierde.
`.trim();
