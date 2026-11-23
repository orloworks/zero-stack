// Without --invite-only nobody is "not invited": the Users pages show no invite state. --invite-only overwrites this file with the real lookup.
export type InviteState = "invited" | "not-invited" | null;
export const inviteState = async (_email: string): Promise<InviteState> => null;
