// Onboarding progress: the steps your app declares, and which of them each user has reached. Pages call these functions, never the onboarding_step table.
// Declare a step by adding its name to STEPS; mark it for a user with `await markStep(userId, "name")` where your code knows they reached it.
// "Signed up" and "Email verified" are derived from the user row, never stored, so they cannot drift (E14).
// The scaffold ships one example step: replace it with your own, or empty the list to hide the Users column and the user detail section.
export const STEPS = ["example-step"] as const;
export type Step = (typeof STEPS)[number];

export const showOnboarding = STEPS.length > 0;

export type StepProgress = { label: string; done: boolean; at: Date | null };
export type Progress = { done: number; total: number; text: string; steps: StepProgress[] };

type Person = { id: string; emailVerified: boolean; createdAt: Date };

// Pure: the two built-in steps from the user row, then each declared step the user reached. A stored step that is no longer declared is ignored.
export function buildProgress(user: Pick<Person, "emailVerified" | "createdAt">, reached: ReadonlyMap<string, Date>): Progress {
  const steps: StepProgress[] = [
    { label: "Signed up", done: true, at: user.createdAt },
    { label: "Email verified", done: user.emailVerified === true, at: null },
    ...STEPS.map((s) => ({ label: s, done: reached.has(s), at: reached.get(s) ?? null })),
  ];
  const done = steps.filter((s) => s.done).length;
  return { done, total: steps.length, text: `${done} of ${steps.length}`, steps };
}

// void/db and @schema are imported on use: Void's plugin loads auth.ts at startup, where bindings are not available.
const store = async () => ({ ...(await import("void/db")), ...(await import("@schema")), ...(await import("../.void/better-auth-schema")) });

// Marks a declared step reached for a user (the first time only). An undeclared name is a bug in the caller, so it throws.
export async function markStep(userId: string, step: Step): Promise<void> {
  if (!(STEPS as readonly string[]).includes(step)) throw new Error(`Undeclared onboarding step: ${step}`);
  const { db, onboardingStep } = await store();
  await db.insert(onboardingStep).values({ userId, step, reachedAt: new Date() }).onConflictDoNothing();
}

// One query for a page of users (the Users list).
export async function progressFor(users: Person[]): Promise<Map<string, Progress>> {
  const out = new Map<string, Progress>();
  if (!users.length) return out;
  const { db, inArray, onboardingStep } = await store();
  const rows = await db.select().from(onboardingStep).where(inArray(onboardingStep.userId, users.map((u) => u.id)));
  const byUser = new Map<string, Map<string, Date>>();
  for (const r of rows) byUser.set(r.userId, (byUser.get(r.userId) ?? new Map()).set(r.step, r.reachedAt));
  for (const u of users) out.set(u.id, buildProgress(u, byUser.get(u.id) ?? new Map()));
  return out;
}

export async function progress(userId: string): Promise<Progress | null> {
  const { db, eq, userTable } = await store();
  const user = (await db.select().from(userTable).where(eq(userTable.id, userId)).limit(1))[0];
  return user ? ((await progressFor([user])).get(userId) ?? null) : null;
}
