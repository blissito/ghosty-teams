// ¿La persona ya eligió SUS repos para Ghosty? (3-nov, Brenda y acaliClub). `GET /user/installations`
// también lista las instalaciones de otros donde la persona es colaboradora (la de blissito), así que
// «hay alguna» no basta: tiene que haber una en SU cuenta. Las organizaciones no se exigen.
export type InstallLite = { account?: { login?: string | null } | null };

export function ownReposMissing(installations: InstallLite[] | null | undefined, login: string | null | undefined): boolean {
  if (!login) return !(installations?.length ?? 0);
  const me = login.toLowerCase();
  return !(installations ?? []).some((i) => (i.account?.login ?? "").toLowerCase() === me);
}
