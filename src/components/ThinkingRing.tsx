// Indicador de "pensando/trabajando" del agente — anillo de puntos que brillan en
// secuencia (estilo Claude) en morado Ghosty. Ligero (CSS puro, sin JS de animación).
export function ThinkingRing({ size = 20 }: { size?: number }) {
  const dots = 12;
  const r = size / 2 - 2; // radio del anillo (deja margen para el punto)
  return (
    <span className="gc-ring" style={{ width: size, height: size }} aria-hidden="true">
      {Array.from({ length: dots }).map((_, i) => (
        <span
          key={i}
          className="gc-ring-dot"
          style={{
            transform: `rotate(${(360 / dots) * i}deg) translateY(-${r}px)`,
            animationDelay: `${(i / dots) * 1.1}s`,
          }}
        />
      ))}
    </span>
  );
}
