import { useId } from "react";

/**
 * Ghosty — la mascota. Portado de EasyBits (`app/routes/dash/fleet-agents.tsx`),
 * con una diferencia: aquí el SVG es AUTOCONTENIDO. Allá el filtro de fieltro
 * (#feltEdge) vive en un `<FeltFilters>` montado aparte en la página; en Teams la
 * mascota aparece en sitios sueltos —la barra del artefacto, la página pública sin
 * layout— así que carga su propio `<defs>`. El id se deriva de useId() porque dos
 * mascotas en la misma página con el mismo id de filtro colisionan.
 *
 * Parpadeo por SMIL, determinista (nada de Math.random → sin desajuste de
 * hidratación). `offset` desfasa el inicio y `period` hace que dos mascotas
 * DERIVEN: si sólo se desfasara el inicio, al montarse dinámicamente el navegador
 * clampa el `begin` negativo y todas parpadearían al unísono.
 */
export function blinkTiming(seed: string): { offset: number; period: number } {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return { offset: (h % 500) / 100, period: 4.3 + ((h >>> 4) % 150) / 100 };
}

export default function GhostyMascot({
  className = "",
  blink = true,
  sleeping = false,
  offset = 0,
  period = 5,
  color = "#9870ED",
}: {
  className?: string;
  blink?: boolean;
  sleeping?: boolean;
  offset?: number;
  period?: number;
  color?: string;
}) {
  const uid = useId().replace(/[:]/g, "");
  const felt = `feltEdge-${uid}`;
  const Blink =
    blink && !sleeping ? (
      <animate
        attributeName="ry"
        values="11;11;1.5;1.5;11;11"
        dur={`${period}s`}
        begin={`-${offset}s`}
        repeatCount="indefinite"
        keyTimes="0;0.88;0.91;0.965;0.99;1"
      />
    ) : null;

  return (
    <svg viewBox="0 0 84 96" className={className} fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <defs>
        {/* borde afelpado: ruido fino que desplaza el contorno (las "fibras") */}
        <filter id={felt} x="-30%" y="-30%" width="160%" height="160%">
          <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="4" seed="3" result="noise" />
          <feDisplacementMap in="SourceGraphic" in2="noise" scale="1.4" xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </defs>
      {/* cuerpo + blush afelpados. Los lentes/ojos quedan FUERA del filtro para que
          se lean nítidos incluso a 20px. */}
      <g filter={`url(#${felt})`}>
        <path
          d="M11 80 L11 41 C11 21 23 5 42 5 C61 5 73 21 73 41 L73 80 Q65.25 88 57.5 80 Q49.75 88 42 80 Q34.25 88 26.5 80 Q18.75 88 11 80 Z"
          fill={color}
        />
        <ellipse cx="23" cy="50" rx="5" ry="3" fill="#B79BF2" />
        <ellipse cx="61" cy="50" rx="5" ry="3" fill="#B79BF2" />
      </g>
      {/* patas de los lentes */}
      <path d="M16 37 L4 33" stroke="#EAE7F4" strokeWidth="4" strokeLinecap="round" />
      <path d="M68 37 L80 33" stroke="#EAE7F4" strokeWidth="4" strokeLinecap="round" />
      {/* puente */}
      <path d="M37 36 Q42 32 47 36" stroke="#EAE7F4" strokeWidth="4" strokeLinecap="round" fill="none" />
      {sleeping ? (
        <>
          <path d="M22 41 Q29 47 36 41" stroke="#1C1726" strokeWidth="3.5" strokeLinecap="round" fill="none" />
          <path d="M48 41 Q55 47 62 41" stroke="#1C1726" strokeWidth="3.5" strokeLinecap="round" fill="none" />
        </>
      ) : (
        <>
          <ellipse cx="29" cy="41" rx="8" ry="11" fill="#1C1726">{Blink}</ellipse>
          <ellipse cx="55" cy="41" rx="8" ry="11" fill="#1C1726">{Blink}</ellipse>
        </>
      )}
      {/* marcos */}
      <circle cx="29" cy="40" r="13.5" stroke="#EAE7F4" strokeWidth="4" />
      <circle cx="55" cy="40" r="13.5" stroke="#EAE7F4" strokeWidth="4" />
    </svg>
  );
}
