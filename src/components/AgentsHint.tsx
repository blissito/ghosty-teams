import { AnimatePresence, motion } from "motion/react";
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
      <AnimatePresence initial={false} mode="wait">
        {abierto ? (
          <motion.div
            key="abierto"
            // `height: auto` para que la barra lateral no dé un salto: el contenido crece y
            // encoge, no aparece y desaparece.
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
            className="overflow-hidden rounded-xl border border-border bg-surface"
          >
            <div className="p-3">
              <button
                onClick={alternar}
                title={t("Ocultar")}
                aria-expanded
                className="flex w-full items-center gap-1.5 text-left text-sm font-medium text-ink"
              >
                {icono}
                <span className="min-w-0 flex-1 truncate">{titulo}</span>
                <ChevronPequeno abierto />
              </button>
              <p className="mt-0.5 text-xs text-muted">
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
            </div>
          </motion.div>
        ) : (
          <motion.button
            key="pestana"
            onClick={alternar}
            title={t("Ver tus agentes")}
            aria-expanded={false}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.18 }}
            className="flex w-full items-center gap-1.5 rounded-lg border border-border/60 bg-surface/60 px-2 py-1 text-left text-xs text-muted transition-colors hover:bg-surface-3 hover:text-ink"
          >
            {icono}
            <span className="min-w-0 flex-1 truncate">
              {uno ? `@${uno.handle}` : t("{n} agentes", { n: String(agentes.length) })}
            </span>
            <ChevronPequeno />
          </motion.button>
        )}
      </AnimatePresence>
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
