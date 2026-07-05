import { createFileRoute } from "@tanstack/react-router";
import { startFormmyLogin } from "../server/auth";
import { LoginCard } from "./login";
import { useT } from "../i18n";

// Landing de invitación: el member entra con Formmy y se une (member).
export const Route = createFileRoute("/join/$token")({
  loader: ({ params }) => startFormmyLogin({ data: { inviteToken: params.token } }),
  component: Join,
});

function Join() {
  const t = useT();
  const { url, formmyOrigin, inviteToken } = Route.useLoaderData();
  return (
    <LoginCard
      url={url}
      formmyOrigin={formmyOrigin}
      inviteToken={inviteToken}
      subtitle={t("Te invitaron a este chat. Entra con Formmy para unirte.")}
    />
  );
}
