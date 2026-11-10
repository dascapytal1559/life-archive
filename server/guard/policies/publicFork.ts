// The policy for a public fork: open-source code on GitHub that anyone can read, merged from its upstream with its
// owner's changes on top. It holds none of the archive's data, so the danger is the other way: a commit about how its
// owner's own setup runs that names their machines, servers, profiles, home folder or personal email, as a dev-journal
// entry once did. The commit check stops those by the private terms kept beside the archive (guard/private-terms.json
// in its folder, dictionary.ts) and by shape, with the archive's names as everywhere; its repository layer,
// FORK_PRIVACY, as the privacy policy sets it (server/privacy/policy.ts, docs/privacy.md), is what the model's review
// judges it by.
//
// Upstream's commits (on the `upstream` remote's branches) are published already, under their own authors, so they are
// left out of every check, and a merge of them is read only for what its own resolution adds.
//
// A fork of one's own is named in the archive's folder (guard/policies.json, privatePolicies.ts), extending this one with
// what is its alone: what it is, the branches it pushes, the words that are ordinary in it.

import { FORK_PRIVACY } from "../../privacy/policy.ts";
import { BUILT_IN, type Policy } from "../policy.ts";

export const PUBLIC_FORK: Policy = {
  name: "public-fork",
  about: "a public fork of open-source code, merged from its upstream with its owner's changes on top",
  keptIn: BUILT_IN,
  nameFiles: [],
  publicRemotes: ["upstream"],
  repo: FORK_PRIVACY,
};
