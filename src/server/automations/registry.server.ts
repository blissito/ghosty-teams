// ── Registro de automatizaciones: cada archivo exporta las suyas ─────────────────────────────
import type { Automation, AutomationKind } from "./types";
import { automations as prFix } from "./pr-fix.server";
import { automations as prReview } from "./pr-review.server";
import { automations as securityFix } from "./security-fix.server";
import { automations as maintenance } from "./maintenance.server";
import { automations as issueTriage } from "./issue-triage.server";
import { automations as ciDoctor } from "./ci-doctor.server";

export const AUTOMATIONS: Automation[] = [...prFix, ...prReview, ...securityFix, ...maintenance, ...issueTriage, ...ciDoctor];

export function automationsOf(kind: AutomationKind): Automation[] {
  return AUTOMATIONS.filter((a) => a.kind === kind);
}
