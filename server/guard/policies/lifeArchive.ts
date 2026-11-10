// The life archive's own policy: the repository layer of the captain's privacy policy, REPO_PRIVACY, as the policy
// sets it (server/privacy/policy.ts, docs/privacy.md). It was friend-map's until friend-map-frontend was archived
// (2026-11-07); it is installed nowhere yet, and is this repository's for when it is published.

import { REPO_PRIVACY } from "../../privacy/policy.ts";
import { BUILT_IN, type Policy } from "../policy.ts";

export const LIFE_ARCHIVE: Policy = {
  name: "life-archive",
  about: "the open-source life archive: the code that builds its owner's (\"the captain's\") private archive on his own machine from his chats, calls, hangouts and agents' sessions, with a map of his friendships, and made-up data to test and demo it; his own instance runs from it, but the archive itself is never in the repository",
  keptIn: BUILT_IN,
  nameFiles: ["server/fixtures/madeUpNames.ts"],
  pushBranches: ["main"],
  repo: REPO_PRIVACY,
};
