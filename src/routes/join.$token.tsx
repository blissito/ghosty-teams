import { createFileRoute } from "@tanstack/react-router";
import { startFormmyLogin } from "../server/auth";
import { LoginCard } from "./login";

// Landing de invitación: el member entra con Formmy y se une (member).
export const Route = createFileRoute("/join/$token")({
  loader: ({ params }) => startFormmyLogin({ data: { inviteToken: params.token } }),
  component: Join,
});

function Join() {
  const { url, formmyOrigin, inviteToken } = Route.useLoaderData();
  return (
    <LoginCard
      url={url}
      formmyOrigin={formmyOrigin}
      inviteToken={inviteToken}
      subtitle="Te invitaron a este chat. Entra con Formmy para unirte."
    />
  );
}
