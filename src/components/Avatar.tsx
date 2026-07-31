// Avatar del chat: imagen si la hay, si no las dos primeras letras del nombre.
// Vivía dentro de c.$slug.tsx; se extrajo para que lo pueda usar también el aviso de
// llamada entrante, que ahora se monta en la raíz (fuera de la ruta del chat).
export function Avatar({ name, avatar, className }: { name?: string; avatar?: string; className?: string }) {
  if (avatar) return <img src={avatar} alt="" loading="lazy" decoding="async" className={`shrink-0 rounded-full ${className}`} />;
  return (
    <div className={`grid shrink-0 place-items-center rounded-full bg-surface-3 text-xs font-semibold text-ink ${className}`}>
      {(name || "?").slice(0, 2).toUpperCase()}
    </div>
  );
}
