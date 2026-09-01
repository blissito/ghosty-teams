// Efectos del chat (```gt-fx```): confeti y compañía, como los zumbidos del Messenger viejo.
//
// EFÍMERO A PROPÓSITO. Estalla cuando el mensaje LLEGA y no vuelve: ni al hacer scroll, ni al
// recargar, ni al re-renderizar. Un canal de clase con treinta confetis persistentes es
// inhabitable, y la gracia del gesto es justo que se pierde si no estabas.
//
// El "ya se disparó" vive en un Set de módulo, no en la fila del mensaje: es estado de ESTA
// pestaña. Guardarlo en el servidor sería inventar una columna para decir algo que sólo le
// importa a un navegador durante dos segundos.
import { useEffect, useState } from "react";

import type { FxKind } from "../../lib/ebdoc";

/** Mensajes que ya celebraron en esta pestaña. */
const alreadyFired = new Set<number>();

/** Cuánto dura la fiesta. Pasado esto el overlay se desmonta y no deja nada en el DOM. */
const DURATION_MS = 2600;

type Particle = { left: number; delay: number; dur: number; hue: number; drift: number; size: number };

function makeParticles(n: number): Particle[] {
  return Array.from({ length: n }, () => ({
    left: Math.random() * 100,
    delay: Math.random() * 0.5,
    dur: 1.6 + Math.random() * 0.9,
    hue: Math.floor(Math.random() * 360),
    drift: (Math.random() - 0.5) * 140,
    size: 6 + Math.random() * 6,
  }));
}

/**
 * ¿La persona pidió menos movimiento? Se comprueba ANTES de montar nada.
 *
 * La regla global de `styles.css` ya recorta la duración de cualquier animación, pero eso
 * dejaría el confeti apareciendo y desapareciendo de golpe — un parpadeo, que para quien pide
 * reduce-motion es peor que nada. Aquí simplemente no hay efecto.
 */
function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return true;
  if (document.documentElement.dataset.prefersReducedMotion === "1") return true;
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

export function FxOverlay({ messageId, fx }: { messageId: number; fx: FxKind }) {
  // Sólo la PRIMERA vez que este mensaje pasa por aquí. El estado inicial se decide en el
  // useState —no en un efecto— para que un re-render no lo reviva.
  const [alive, setAlive] = useState(() => {
    if (alreadyFired.has(messageId) || prefersReducedMotion()) return false;
    alreadyFired.add(messageId);
    return true;
  });
  const [parts] = useState(() => (fx === "shake" ? [] : makeParticles(fx === "snow" ? 40 : 60)));

  useEffect(() => {
    if (!alive) return;
    const to = setTimeout(() => setAlive(false), DURATION_MS);
    return () => clearTimeout(to);
  }, [alive]);

  useEffect(() => {
    if (!alive || fx !== "shake") return;
    // El zumbido se le hace a la ventana entera, que es lo que era en Messenger.
    document.body.classList.add("gt-fx-shake");
    const to = setTimeout(() => document.body.classList.remove("gt-fx-shake"), 700);
    return () => {
      clearTimeout(to);
      document.body.classList.remove("gt-fx-shake");
    };
  }, [alive, fx]);

  if (!alive || fx === "shake") return null;

  return (
    // `pointer-events-none` no es cosmético: sin él, dos segundos de confeti se tragan los
    // clics de todo el que esté leyendo.
    <div className="gt-fx pointer-events-none fixed inset-0 z-[90] overflow-hidden" aria-hidden="true">
      {parts.map((p, i) => (
        <span
          key={i}
          className={`gt-fx-p gt-fx-${fx}`}
          style={{
            left: `${p.left}%`,
            width: fx === "hearts" ? undefined : p.size,
            height: fx === "hearts" ? undefined : p.size,
            fontSize: fx === "hearts" ? p.size * 2 : undefined,
            background: fx === "confetti" ? `hsl(${p.hue} 85% 60%)` : undefined,
            animationDelay: `${p.delay}s`,
            animationDuration: `${p.dur}s`,
            ["--gt-fx-drift" as string]: `${p.drift}px`,
          }}
        >
          {fx === "hearts" ? "❤" : null}
        </span>
      ))}
    </div>
  );
}
