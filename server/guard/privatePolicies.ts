// Every policy the guard knows: those any installation has (policies/: the life archive's own, and a public fork's),
// and the repositories of this installation's own, named in the archive's folder (guard/policies.json, beside the
// private terms), never in this repository, since which repositories they are and what is ordinary in each is the
// installation's alone. Each of those extends a policy from policies/, giving what is its own: what it is, and, where
// it differs, its made-up names' files, the branches it pushes, its public remotes and the words that are ordinary in it.
//
//   { "policies": { "<name>": { "extends": "public-fork", "about": "<what it is>", "pushBranches": ["main"], "allowed": ["<word>"] } } }
//
// `npm run guard -- policies import <file>` adds a file of them in that shape, checked, to those already there (one of
// the same name is replaced); `npm run guard -- policies` lists them all. A guard/policies.json that cannot be read stops
// every check rather than run without the policies it names.

import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Data, Effect, Schema } from "effect";
import { atomicWrite } from "../files.ts";
import { guardFolder } from "./dictionary.ts";
import { LIFE_ARCHIVE } from "./policies/lifeArchive.ts";
import { PUBLIC_FORK } from "./policies/publicFork.ts";
import type { Policy } from "./policy.ts";

/** The policies any installation has, by name. A policy for every installation goes in policies/ and here. */
export const BUILT_IN_POLICIES: Readonly<Record<string, Policy>> = Object.fromEntries([LIFE_ARCHIVE, PUBLIC_FORK].map((policy) => [policy.name, policy]));

/** The policy `name` among `policies`, by its own name only: never a name every object has (`constructor`, `toString`). */
export const policyNamed = (policies: Readonly<Record<string, Policy>>, name: string | undefined): Policy | undefined =>
  name !== undefined && Object.hasOwn(policies, name) ? policies[name] : undefined;

/** One policy of the installation's own, as guard/policies.json holds it: the built-in policy it extends, and what is its own. */
const PrivatePolicy = Schema.Struct({
  extends: Schema.String,
  about: Schema.optionalKey(Schema.String),
  nameFiles: Schema.optionalKey(Schema.Array(Schema.String)),
  pushBranches: Schema.optionalKey(Schema.Array(Schema.String)),
  publicRemotes: Schema.optionalKey(Schema.Array(Schema.String)),
  allowed: Schema.optionalKey(Schema.Array(Schema.String)),
});
type PrivatePolicy = typeof PrivatePolicy.Type;

const PoliciesFile = Schema.Struct({ policies: Schema.Record(Schema.String, PrivatePolicy) });

/** guard/policies.json in the archive's folder. */
export const policiesFile = (archiveDir: string) => join(guardFolder(archiveDir), "policies.json");

/** Where a policy of the installation's own is kept, as a refusal names it. */
const KEPT_IN = "guard/policies.json in the life archive's folder";

/** A policies file that cannot be read or does not hold good policies. */
export class PolicyFileError extends Data.TaggedError("PolicyFileError")<{ readonly message: string }> {}

/** A name a policy's records' folder can take: lower case, digits, dots, dashes and underscores. */
const NAME = /^[a-z0-9][a-z0-9._-]*$/;

/** The policies `file` holds, as written there (none when it is not there). */
const readEntries = (file: string) =>
  Effect.gen(function* () {
    if (!existsSync(file)) return {} as Record<string, PrivatePolicy>;
    const text = yield* Effect.tryPromise({ try: () => readFile(file, "utf8"), catch: (error) => new PolicyFileError({ message: `could not read ${file}: ${(error as Error).message}` }) });
    return yield* Effect.try({
      try: () => Schema.decodeUnknownSync(PoliciesFile)(JSON.parse(text), { onExcessProperty: "error" }).policies,
      catch: (error) => new PolicyFileError({ message: `${file} does not hold policies in the shape guard/policies.json takes: ${(error as Error).message}` }),
    });
  });

/** Each entry as a whole policy, its built-in one's fields where it gives none; a bad name or an unknown base is refused. */
const resolve = (entries: Record<string, PrivatePolicy>, file: string) =>
  Effect.gen(function* () {
    const resolved: Record<string, Policy> = {};
    for (const [name, entry] of Object.entries(entries)) {
      const refuse = (why: string) => new PolicyFileError({ message: `${file}: the policy "${name}" ${why}` });
      if (!NAME.test(name)) return yield* refuse("is not a name a policy can take (lower case letters, digits, dots, dashes and underscores)");
      if (policyNamed(BUILT_IN_POLICIES, name)) return yield* refuse("has the name of one every installation has; give it another");
      const base = policyNamed(BUILT_IN_POLICIES, entry.extends);
      if (!base) return yield* refuse(`extends "${entry.extends}", which is not one of ${Object.keys(BUILT_IN_POLICIES).join(", ")}`);
      const { extends: _base, ...own } = entry;
      resolved[name] = { ...base, ...Object.fromEntries(Object.entries(own).map(([key, value]) => [key, Array.isArray(value) ? [...value] : value])), name, keptIn: KEPT_IN };
    }
    return resolved;
  });

/** Every policy, by name: the built-in ones and the archive folder's own. */
export const loadPolicies = (archiveDir: string) =>
  Effect.gen(function* () {
    const file = policiesFile(archiveDir);
    return { ...BUILT_IN_POLICIES, ...(yield* resolve(yield* readEntries(file), file)) };
  });

/**
 * Adds the policies `from` holds to guard/policies.json in the archive's folder, each checked as the guard will read it,
 * replacing any of the same name, and says which it added and replaced. Nothing is written when any is refused.
 */
export const importPolicies = (archiveDir: string, from: string) =>
  Effect.gen(function* () {
    if (!existsSync(from)) return yield* new PolicyFileError({ message: `there is no ${from}` });
    const incoming = yield* readEntries(from);
    if (Object.keys(incoming).length === 0) return yield* new PolicyFileError({ message: `${from} names no policies` });
    yield* resolve(incoming, from);
    const file = policiesFile(archiveDir);
    const kept = yield* readEntries(file);
    const merged = { ...kept, ...incoming };
    yield* resolve(merged, file);
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(guardFolder(archiveDir), { recursive: true });
        await atomicWrite(file, `${JSON.stringify({ policies: merged }, null, 2)}\n`);
      },
      catch: (error) => new PolicyFileError({ message: `could not write ${file}: ${(error as Error).message}` }),
    });
    const names = Object.keys(incoming);
    return { file, added: names.filter((name) => !Object.hasOwn(kept, name)), replaced: names.filter((name) => Object.hasOwn(kept, name)) };
  });
