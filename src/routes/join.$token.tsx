import { createFileRoute } from "@tanstack/react-router";
import { LoginCard, parseLoginSearch, runLoginLoader } from "./login";
import { useT } from "../i18n";

// Landing de invitación: el member entra con Ghosty.studio y se une (member). Reusa el
// mismo loader isomórfico que /login — el redirect al IdP y la creación de sesión pasan
// server-side; el `inviteToken` (params.token) viaja por el handshake y se consume al
// completar. El card solo aparece como fallback manual (ver runLoginLoader).
export const Route = createFileRoute("/join/$token")({
  // Preview específico de invitación (sobrescribe el og:title/description del root;
  // la imagen se hereda). Así el link /join/… se ve como una invitación al compartirlo.
  head: () => ({
    meta: [
      { title: "Te invitaron a Ghosty Teams" },
      { property: "og:title", content: "Te invitaron a un chat de equipo" },
      { property: "og:description", content: "Ábrelo para unirte al equipo en Ghosty Teams." },
      { name: "twitter:title", content: "Te invitaron a un chat de equipo" },
      { name: "twitter:description", content: "Ábrelo para unirte al equipo en Ghosty Teams." },
    ],
  }),
  validateSearch: (s: Record<string, unknown>) => parseLoginSearch(s),
  loaderDeps: ({ search }) => search,
  loader: ({ params, deps }) => runLoginLoader(deps, params.token),
  component: Join,
});

function Join() {
  const t = useT();
  const { token } = Route.useParams();
  const { error } = Route.useLoaderData();
  return (
    <LoginCard
      error={error}
      retryTo={`/join/${token}`}
      subtitle={t("Te invitaron a este chat. Entra para unirte.")}
    />
  );
}
