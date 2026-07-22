import { createFileRoute } from "@tanstack/react-router";
import { startGhostyLogin } from "../server/auth";
import { LoginCard } from "./login";
import { useT } from "../i18n";

// Landing de invitación: el member entra con Ghosty.studio y se une (member).
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
  loader: ({ params }) => startGhostyLogin({ data: { inviteToken: params.token } }),
  component: Join,
});

function Join() {
  const t = useT();
  const { url, inviteToken } = Route.useLoaderData();
  return (
    <LoginCard
      url={url}
      inviteToken={inviteToken}
      subtitle={t("Te invitaron a este chat. Entra para unirte.")}
    />
  );
}
