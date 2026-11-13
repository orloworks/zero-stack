// The ci:full permutations. Every framework with all flags valid for it, plus single-flag and bare runs.
const all = ["--tailwind", "--zod-rpc", "--auth"];
export const MATRIX: { name: string; args: string[] }[] = [
  { name: "react-all", args: ["--framework", "react", "--tailwind", "--shadcn", "--zod-rpc", "--auth"] },
  ...["vue", "svelte", "solid"].map((fw) => ({ name: `${fw}-all`, args: ["--framework", fw, ...all] })),
  { name: "bare", args: [] },
  { name: "auth", args: ["--auth"] },
  { name: "tailwind", args: ["--tailwind"] },
  { name: "zod-rpc", args: ["--zod-rpc"] },
];
