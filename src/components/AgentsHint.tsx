import { motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useT } from "../i18n";
import { Avatar } from "./Avatar";

/**
 * El cartel de "tus agentes están aquí", que se quita de en medio solo.
 *
 * Es un cartel ÚTIL —dice con qué handle se invoca a cada agente, y sin eso nadie los
 * menciona— pero vive en la barra lateral, encima de la lista de conversaciones, y ahí
 * estorba a quien ya se lo sabe. La salida no es esconderlo tras un ajuste que nadie va a
 * buscar: se muestra, se repliega solo, y deja una pestañita para volver a verlo.
 *
 * Tres reglas, y las tres importan:
 *
 *  1. **La primera vez se queda quieto** hasta que se lea. En visitas siguientes nace
 *     plegado: si ya lo viste, la información ya la tienes y lo que queda es el estorbo.
 *  2. **Un clic tuyo manda sobre el temporizador.** Si lo cierras a mano, no se vuelve a
 *     abrir solo; si lo abres, se cierra al rato — pero no mientras el puntero esté encima,
 *     porque cerrarle algo a alguien que lo está leyendo es peor que no cerrarlo nunca.
 *  3. **Con `prefers-reduced-motion` no se anima**, pero SÍ se pliega: el que pidió menos
 *     movimiento no pidió más ruido en pantalla.
 */
export function AgentsHint({
  agentes,
}: {
  agentes: { handle: string; name: string; avatar?: string | null }[];
}) {
  const t = useT();
  // `null` mientras no sepamos si es la primera vez: pintar abierto y plegar de golpe se ve
  // como un parpadeo. Se resuelve en el primer efecto, antes de la primera pintura visible.
  const [abierto, setAbierto] = useState<boolean | null>(null);
  const [encima, setEncima] = useState(false);
  /** Cerrado A MANO: a partir de ahí el temporizador no vuelve a tocar nada. */
  const manual = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const VISTO = "gt-agents-hint-visto";

  useEffect(() => {
    let visto = false;
    try {
      visto = localStorage.getItem(VISTO) === "1";
    } catch {
      /* sin storage se comporta como la primera vez, que es el lado amable del fallo */
    }
    setAbierto(!visto);
  }, []);

  const programarCierre = useCallback((ms: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setAbierto(false), ms);
  }, []);

  // Auto-plegado. El reloj se PARA mientras el puntero está encima y se reanuda al salir.
  useEffect(() => {
    if (abierto !== true || manual.current) return;
    if (encima) {
      if (timer.current) clearTimeout(timer.current);
      return;
    }
    programarCierre(6000);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [abierto, encima, programarCierre]);

  // Se marca como visto al plegarse, no al montar: si alguien entra y sale sin llegar a
  // leerlo, la próxima vez se lo merece otra vez.
  useEffect(() => {
    if (abierto === false) {
      try {
        localStorage.setItem(VISTO, "1");
      } catch {
        /* da igual: como mucho lo vuelve a ver */
      }
    }
  }, [abierto]);

  if (!agentes.length) return null;

  const uno = agentes.length === 1 ? agentes[0] : null;
  const icono = uno?.avatar ? (
    <Avatar name={uno.name} avatar={uno.avatar} className="h-4 w-4" />
  ) : (
    <img src="/ghosty.svg" alt="" className="h-4 w-4" />
  );
  const titulo = uno ? t("{name} está aquí", { name: uno.name }) : t("Tus agentes están aquí");

  const alternar = () => {
    const siguiente = !abierto;
    // Abrir con un clic NO es "manual" en el sentido de fijarlo: se vuelve a plegar solo.
    // Cerrarlo sí lo es — es la señal de "ya lo sé, déjame en paz".
    manual.current = !siguiente;
    setAbierto(siguiente);
    if (siguiente) programarCierre(10000);
  };

  return (
    <div className="mx-2 mb-2" onMouseEnter={() => setEncima(true)} onMouseLeave={() => setEncima(false)}>
      {/*
        UNA sola caja que crece y encoge, no dos que se relevan.

        ⚠️ Antes eran dos elementos dentro de un `AnimatePresence mode="wait"`: la tarjeta y
        la pestañita. Con `mode="wait"` el que sale tiene que TERMINAR antes de que monte el
        que entra, así que al plegarse el contenedor pasaba por altura CERO —la barra lateral
        se cerraba del todo— y volvía a abrirse al aparecer la pestaña. Se veía como un
        brinco, y no era la animación: era el hueco entre las dos.

        La cabecera es la MISMA fila en los dos estados (icono · texto · flecha), así que no
        hay nada que relevar: se queda montada y sólo colapsa el cuerpo. De paso el botón no
        se remonta, que es lo que hacía que el puntero perdiera el hover a media transición.
      */}
      <motion.div
        // El marco se atenúa al plegarse en vez de desaparecer: plegado es una pestañita
        // discreta, no otra cosa.
        animate={{ opacity: abierto ? 1 : 0.75 }}
        transition={{ duration: 0.2 }}
        className={`overflow-hidden rounded-xl border transition-colors ${
          abierto ? "border-border bg-surface" : "border-border/60 bg-surface/60 hover:bg-surface-3"
        }`}
      >
        <button
          onClick={alternar}
          title={abierto ? t("Ocultar") : t("Ver tus agentes")}
          aria-expanded={!!abierto}
          className={`flex w-full items-center gap-1.5 text-left transition-[padding,font-size] duration-200 ${
            abierto ? "p-3 pb-1.5 text-sm font-medium text-ink" : "px-2 py-1 text-xs text-muted hover:text-ink"
          }`}
        >
          {icono}
          <span className="min-w-0 flex-1 truncate">
            {abierto ? titulo : uno ? `@${uno.handle}` : t("{n} agentes", { n: String(agentes.length) })}
          </span>
          <ChevronPequeno abierto={!!abierto} />
        </button>
        {/*
          El cuerpo. `height: auto` mide el contenido real, así que no hay que clavar una
          altura que se rompa cuando el workspace tenga un agente más.

          `abierto === null` (todavía no sabemos si es la primera visita) se trata como
          CERRADO y sin animación: pintar abierto y plegar de golpe es el parpadeo que este
          componente ya evitaba antes.
        */}
        <motion.div
          initial={false}
          animate={{ height: abierto ? "auto" : 0, opacity: abierto ? 1 : 0 }}
          transition={{ duration: 0.22, ease: "easeOut" }}
          className="overflow-hidden"
          aria-hidden={!abierto}
        >
          <p className="px-3 pb-3 text-xs text-muted">
            {/* Sin `.slice(0, 3)`: el cap silencioso dejaba fuera al CUARTO agente y la
                tarjeta se leía como si no existiera (pasó con @deep el 2026-08-08). Aquí
                no sobra espacio para inventar un "+N": son los handles con los que se
                invoca al agente, y un handle que no se ve es un agente que nadie menciona. */}
            {agentes.map((a, i) => (
              <span key={a.handle}>
                {i > 0 ? " · " : ""}
                <span className="text-brand">@{a.handle}</span>
              </span>
            ))}
            <br />
            {uno
              ? t("Menciónalo en un room o hilo y responde ahí mismo.")
              : t("Menciónalos en un room o hilo y responden ahí mismo.")}
          </p>
        </motion.div>
      </motion.div>
    </div>
  );
}

/** La flecha, que gira en vez de cambiar de icono: es el mismo control, no otro. */
function ChevronPequeno({ abierto = false }: { abierto?: boolean }) {
  return (
    <motion.svg
      viewBox="0 0 24 24"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="shrink-0 text-muted"
      animate={{ rotate: abierto ? 180 : 0 }}
      transition={{ duration: 0.2 }}
    >
      <path d="m6 9 6 6 6-6" />
    </motion.svg>
  );
}
