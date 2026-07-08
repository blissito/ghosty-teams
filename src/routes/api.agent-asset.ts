import { createFileRoute } from "@tanstack/react-router";

// Sube un ENTREGABLE directo a EasyBits para un fleet agent. POST multipart (`file`)
// + `?id=<agentId>`. Autentica con la sesión (owner/colaborador), resuelve el
// fleet_token server-side (NUNCA al browser) y reenvía el multipart a la API
// capabilities de EasyBits, que crea el archivo público y lo adjunta a los assets.
const MAX_BYTES = 25 * 1024 * 1024;

export const Route = createFileRoute("/api/agent-asset")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const { sessionUser } = await import("../server/chat");
        const user = await sessionUser();
        if (!user) return new Response("unauthorized", { status: 401 });

        const agentId = Number(new URL(request.url).searchParams.get("id"));
        if (!agentId) return new Response("missing agent id", { status: 400 });

        let form: FormData;
        try { form = await request.formData(); } catch { return new Response("bad request", { status: 400 }); }
        const file = form.get("file");
        if (!(file instanceof File)) return new Response("no file", { status: 400 });
        if (file.size === 0) return new Response("empty file", { status: 400 });
        if (file.size > MAX_BYTES) return new Response("file too large", { status: 413 });

        const { resolveFleetAgent, EB } = await import("../server/agent-config");
        let be: { id: string; token: string } | null;
        try { be = await resolveFleetAgent(agentId); } catch (e) { return new Response((e as Error).message, { status: 403 }); }
        if (!be) return new Response("agent is not a fleet agent", { status: 400 });

        const fd = new FormData();
        fd.set("action", "upload-asset");
        fd.set("groupId", "*");
        fd.set("file", file, file.name);
        const res = await fetch(`${EB}/api/v2/fleet-agents/${be.id}/capabilities`, {
          method: "POST",
          headers: { Authorization: `Bearer ${be.token}` },
          body: fd,
        });
        if (!res.ok) return new Response(`upload failed: ${await res.text()}`, { status: 502 });
        return Response.json(await res.json());
      },
    },
  },
});
