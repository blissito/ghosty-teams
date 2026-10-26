// Lo que la UI enseña de cada automatización: nombre y una línea de qué hace. Sin dependencias de
// servidor (lo importa el panel del repo). El copy pasa por `t()`: las claves viven en i18n.en.ts.
import type { AutomationKind } from "./types";

export const AUTOMATION_CATALOG: { kind: AutomationKind; name: string; line: string }[] = [
  { kind: "ci_fix", name: "Arreglar CI rojo", line: "Si el CI de un PR sale en rojo, @build lo arregla en la rama del PR." },
  { kind: "dep_fix", name: "Arreglar PRs de dependencias", line: "Si un PR de Dependabot o Renovate rompe el CI, @build lo deja en verde." },
  { kind: "pr_to_green", name: "Resolver conflictos", line: "Si un PR queda en conflicto con la rama principal, se actualiza y se resuelve." },
  { kind: "pr_review", name: "Revisar PRs", line: "Cada PR que una persona abre o marca listo lo revisa @check; sólo comenta lo grave." },
  { kind: "review_autofix", name: "Atender comentarios de review", line: "Un comentario de review de una persona se corrige y se contesta en su hilo." },
  { kind: "security_fix", name: "Arreglar alertas de seguridad", line: "Las alertas de code scanning y Dependabot se arreglan juntas en un PR en borrador." },
  { kind: "maintenance", name: "Mantenimiento programado", line: "Cada semana revisa dependencias, docs y TODOs, y abre un issue o un PR en borrador." },
  { kind: "issue_triage", name: "Clasificar issues", line: "Cada issue nuevo recibe etiquetas, se marca si es duplicado o se pide cómo reproducirlo." },
  { kind: "ci_doctor", name: "Diagnosticar el CI", line: "Cuando falla el CI explica por qué; las pruebas intermitentes se juntan en un issue." },
];

export const AUTOMATION_KINDS = AUTOMATION_CATALOG.map((a) => a.kind);

export function isAutomationKind(k: unknown): k is AutomationKind {
  return typeof k === "string" && (AUTOMATION_KINDS as string[]).includes(k);
}
