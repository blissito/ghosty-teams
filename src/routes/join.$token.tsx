import { createFileRoute } from "@tanstack/react-router";
import { startGhostyLogin } from "../server/auth";
import { LoginCard } from "./login";
import { useT } from "../i18n";

// Landing de invitación: el member entra con Ghosty.studio y se une (member).
export const Route = createFileRoute("/join/$token")({
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
