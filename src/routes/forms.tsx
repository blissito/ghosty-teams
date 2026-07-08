import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { FileText, ExternalLink, Copy, Check, ArrowLeft, MessageSquare } from "lucide-react";
import { me } from "../server/auth";
import { listTeamFormsFn } from "../server/forms";

export const Route = createFileRoute("/forms")({
  loader: async () => {
    const user = await me();
    const forms = user ? await listTeamFormsFn() : [];
    return { user, forms };
  },
  component: FormsPage,
});

function fmtDate(ts: number | null): string {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleDateString("es-MX", { day: "numeric", month: "short" });
}

function FormsPage() {
  const { forms } = Route.useLoaderData();
  const [copied, setCopied] = useState<string | null>(null);

  const copy = (url: string, id: string) => {
    navigator.clipboard?.writeText(url).then(() => {
      setCopied(id);
      setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500);
    });
  };

  return (
    <div className="min-h-screen bg-[#14121a] text-gray-100">
      <div className="max-w-3xl mx-auto px-5 py-8">
        <Link to="/c/$slug" params={{ slug: "general" }} className="inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-200 mb-4">
          <ArrowLeft size={15} /> Volver al chat
        </Link>
        <header className="mb-6">
          <h1 className="text-2xl font-bold flex items-center gap-2"><FileText size={22} className="text-[#a78bfa]" /> Formularios</h1>
          <p className="text-gray-500 text-sm mt-1">
            Formularios de intake de tus expedientes. Las respuestas caen en el room del cliente como ficha descargable.
          </p>
        </header>

        {forms.length === 0 ? (
          <div className="border border-dashed border-gray-700 rounded-2xl p-10 text-center text-gray-500 text-sm">
            <p className="font-semibold text-gray-300 mb-1">Aún no hay formularios en tus expedientes</p>
            <p>Pídele a <span className="text-[#a78bfa]">@ghosty</span> “crea un formulario de diagnóstico” en el room del cliente.</p>
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {forms.map((f) => (
              <li key={f.formId} className="border border-gray-800 bg-[#1c1922] rounded-2xl p-4 flex flex-wrap items-center gap-x-4 gap-y-2">
                <div className="flex-1 min-w-[200px]">
                  <div className="font-semibold text-[15px]">{f.name}</div>
                  <div className="text-xs text-gray-500 mt-1 flex items-center gap-3 flex-wrap">
                    {f.roomName ? <span className="inline-flex items-center gap-1"><MessageSquare size={12} /> {f.roomName}</span> : null}
                    {f.lastSubmittedAt ? <span>última: {fmtDate(f.lastSubmittedAt)}</span> : null}
                  </div>
                </div>
                {f.roomSlug ? (
                  <Link
                    to="/c/$slug"
                    params={{ slug: f.roomSlug }}
                    title="Ver las respuestas en el room del expediente"
                    className="text-center px-3 py-1 rounded-lg hover:bg-white/5"
                  >
                    <div className="text-xl font-bold text-[#a78bfa] tabular-nums">{f.submissions}</div>
                    <div className="text-[10px] uppercase tracking-wide text-gray-500">respuestas ↗</div>
                  </Link>
                ) : (
                  <div className="text-center px-3">
                    <div className="text-xl font-bold text-[#a78bfa] tabular-nums">{f.submissions}</div>
                    <div className="text-[10px] uppercase tracking-wide text-gray-600">respuestas</div>
                  </div>
                )}
                {f.url ? (
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => copy(f.url!, f.formId)}
                      className="inline-flex items-center gap-1.5 text-xs font-medium border border-gray-700 rounded-lg px-3 py-2 hover:bg-white/5"
                    >
                      {copied === f.formId ? <><Check size={13} /> Copiado</> : <><Copy size={13} /> Copiar liga</>}
                    </button>
                    <a
                      href={f.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 text-xs font-semibold bg-[#7c5ce0] text-white rounded-lg px-3 py-2 hover:brightness-110"
                    >
                      <ExternalLink size={13} /> Abrir
                    </a>
                  </div>
                ) : (
                  <span className="text-xs text-gray-600 italic">sin liga</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
