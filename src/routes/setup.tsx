import { createFileRoute, Outlet } from "@tanstack/react-router";

// LAYOUT de /setup — solo renderiza <Outlet/>. El wizard de onboarding vive en
// setup.index.tsx (index exacto de /setup); las rutas hijas del OAuth per-user
// (/setup/$provider/connect|callback, /setup/easybits/*) se renderizan aquí debajo.
//
// Antes setup.tsx ERA el wizard y a la vez el padre de esas rutas SIN <Outlet/>: si
// un connect/callback fallaba o no completaba su redirect, el usuario caía en el
// wizard deprecado "Conecta tu EasyBits" (p.ej. Calendly sin CALENDLY_CLIENT_ID en el
// box → startConnect throw → wizard). Separar layout/index desacopla eso: un fallo del
// conector muestra su propio boundary, no el onboarding. Bonus: el guard isOwner (que
// vivía en el loader padre) ya no bloquea a NO-owners de conectar sus integraciones.
export const Route = createFileRoute("/setup")({
  component: () => <Outlet />,
});
