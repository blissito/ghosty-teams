/**
 * EL interruptor de Ghosty Teams. Uno solo.
 *
 * Había tres copias —`Toggle` en SettingsContent y sendos `Switch` en FleetAgentControls y
 * FleetCapabilities— con el mismo dibujo y bugs distintos: el de Ajustes se rompía dentro
 * de un contenedor flex y los otros no, porque a esos alguien ya les había puesto
 * `shrink-0`. Un control que se ve en veinte sitios no puede vivir en tres archivos.
 */
export function Toggle({
  on,
  onChange,
  disabled,
  label,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  /** Para cuando el texto de al lado no es un `<label>` asociado. */
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      // ⚠️ `shrink-0`: dentro de un flex el track se comprimía por debajo de sus 44px y la
      // bolita —que mide 20 y no encoge— se salía por la derecha. Se veía roto justo donde
      // el interruptor convive con texto largo, que es casi siempre.
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
        on ? "bg-brand" : "bg-surface-3"
      }`}
    >
      {/* El desplazamiento va por `translate` y no por `left`: así depende del ancho real
          del track y no de un 22px calculado a mano que sólo cuadra a un tamaño. */}
      <span
        className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
          on ? "translate-x-5" : "translate-x-0"
        }`}
      />
    </button>
  );
}
