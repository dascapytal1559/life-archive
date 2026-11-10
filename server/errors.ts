// Errors a route answers with a status: 404, 400, 409 and 403 (jsonApi.ts's serve, the one place that maps them).
// Each is a tagged error, so Effect code fails with it (`return yield* new NotFoundError("...")`) and catches it by tag;
// the archive's rules, which stay plain, throw it, and a route lifts what they throw into its type (jsonApi.ts's
// answering). A subclass (QueryError, UndoConflictError) keeps its parent's tag, and so its status.

import { Data } from "effect";

/** A route error is made from its message alone, as the rules throw it. */
const routeError = <Tag extends string>(tag: Tag) =>
  class extends Data.TaggedError(tag)<{ readonly message: string }> {
    constructor(message: string) {
      super({ message });
    }
  };

/** No such thing: 404. */
export class NotFoundError extends routeError("NotFoundError") {}
/** The request is wrong: 400. */
export class InvalidInputError extends routeError("InvalidInputError") {}
/** The request is fine, but cannot be done now (a chat whose connector is not connected, say): 409. */
export class UnavailableError extends routeError("UnavailableError") {}
/** The request came from another site (see fromOwnPage in jsonApi.ts): 403. */
export class ForbiddenError extends routeError("ForbiddenError") {}

export type RouteError = NotFoundError | InvalidInputError | UnavailableError | ForbiddenError;

/** The status each route error is answered with. */
export const STATUS: Record<RouteError["_tag"], number> = {
  NotFoundError: 404,
  InvalidInputError: 400,
  UnavailableError: 409,
  ForbiddenError: 403,
};
