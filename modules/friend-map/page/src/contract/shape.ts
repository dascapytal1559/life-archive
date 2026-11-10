// Shapes of JSON answers, written once and used twice: contract-check tests a backend's answers against them (test),
// and the page fills in what a backend may leave out (fill). A shape is typed by the type it reads (archive.ts), and
// an object's shape must name every field of its type, so a field added to a type and not here is a type error.
//
//   object("Draft", { id: number, personId: number, text: string, createdAt: number, updatedAt: number })
//   optional(array(string), () => [], "[]")      a field a backend may leave out, and what the page puts in its place
//   absent(string)                               a field the type itself marks `?`: there or not, never filled

/** Something wrong with an answer: where (a path such as people[3].accounts[0].platform) and what. Never the value. */
export interface Problem {
  path: string;
  problem: string;
}

export interface Shape<T> {
  /** As the docs name it: "number", "string | null", "PersonSummary[]". */
  readonly describe: string;
  /** The object's name, for an object's shape. */
  readonly name?: string;
  /** The shapes it is made of: an array's items', a nullable's own, an object's fields'. */
  readonly parts?: readonly AnyShape[];
  /** Adds what is wrong with `value` as this shape to `problems`, each at its path under `at`. */
  test(value: unknown, at: string, problems: Problem[]): void;
  /** `value`, which test found nothing wrong with, with every optional field it leaves out filled in. */
  fill(value: unknown): T;
  /** Never set: it makes a Shape<"a"> no Shape<string>, so a field's shape is its type's exactly. */
  readonly _type?: (value: T) => T;
}

/** A shape of any type: a list of answers' shapes, or a shape only tested, never filled into a type. */
export type AnyShape = Shape<any>;

/** A field a backend may leave out (or send as null when its type has no null), and what the page puts in its place. */
export interface Optional<T, P> {
  readonly kind: "optional";
  readonly shape: Shape<T>;
  /** The value in its place, from the fields filled so far (those named before it, and every required one). */
  readonly fallback: (parent: P) => T;
  /** What that is, for the docs: "[]", "worked out from `months`". */
  readonly says: string;
  /** One of the life archive's own: no backend needs it, and the page does without it. */
  readonly extension: boolean;
}

/** A field its type marks `?`: there or not. */
export interface Absent<T> {
  readonly kind: "absent";
  readonly shape: Shape<T>;
}

type Field<T, P> = Shape<T> | Optional<T, P>;

/** Every field of T: an Absent for one its type marks `?`, else its shape or an Optional. */
export type Fields<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? Absent<Exclude<T[K], undefined>> : Field<T[K], T> };

const kindOf = (value: unknown) => (value === null ? "null" : Array.isArray(value) ? "an array" : typeof value === "object" ? "an object" : `a ${typeof value}`);

function leaf<T>(describe: string, ok: (value: unknown) => boolean, expected = describe): Shape<T> {
  return {
    describe,
    test(value, at, problems) {
      if (!ok(value)) problems.push({ path: at, problem: `should be ${expected}, not ${kindOf(value)}` });
    },
    fill: (value) => value as T,
  };
}

export const number: Shape<number> = leaf("number", (v) => typeof v === "number" && Number.isFinite(v), "a number");
export const string: Shape<string> = leaf("string", (v) => typeof v === "string", "a string");
export const boolean: Shape<boolean> = leaf("boolean", (v) => typeof v === "boolean", "true or false");
/** Something the contract does not look into (a value the page passes through as it is). */
export const anything: Shape<unknown> = leaf("unknown", () => true);
/** The JSON null itself (an answer of nothing). */
export const nothing: Shape<null> = leaf("null", (v) => v === null, "null");

/** `shape` as the docs name it in other words: a number that is a moment, say. */
export function named<T>(shape: Shape<T>, describe: string): Shape<T> {
  return { ...shape, describe };
}

/** A string the contract writes a certain way: a day, a month, a time of day. */
export function pattern<T extends string = string>(describe: string, test: RegExp): Shape<T> {
  return {
    describe,
    test(value, at, problems) {
      if (typeof value !== "string") problems.push({ path: at, problem: `should be ${describe}, a string, not ${kindOf(value)}` });
      else if (!test.test(value)) problems.push({ path: at, problem: `should be ${describe}` });
    },
    fill: (value) => value as T,
  };
}

/** One of these strings. */
export function literal<const T extends readonly string[]>(...values: T): Shape<T[number]> {
  const describe = values.map((v) => JSON.stringify(v)).join(" | ");
  return {
    describe,
    test(value, at, problems) {
      if (!values.includes(value as string)) problems.push({ path: at, problem: `should be one of ${describe}${typeof value === "string" ? "" : `, not ${kindOf(value)}`}` });
    },
    fill: (value) => value as T[number],
  };
}

export function nullable<T>(shape: Shape<T>): Shape<T | null> {
  return {
    describe: `${shape.describe} | null`,
    parts: [shape],
    test(value, at, problems) {
      if (value !== null) shape.test(value, at, problems);
    },
    fill: (value) => (value === null ? null : shape.fill(value)),
  };
}

export function array<T>(shape: Shape<T>): Shape<T[]> {
  return {
    describe: shape.describe.includes(" ") ? `Array<${shape.describe}>` : `${shape.describe}[]`,
    parts: [shape],
    test(value, at, problems) {
      if (!Array.isArray(value)) return void problems.push({ path: at, problem: `should be an array, not ${kindOf(value)}` });
      value.forEach((item, i) => shape.test(item, `${at}[${i}]`, problems));
    },
    fill: (value) => (value as unknown[]).map((item) => shape.fill(item)),
  };
}

export function tuple<A, B>(a: Shape<A>, b: Shape<B>): Shape<[A, B]> {
  return {
    describe: `[${a.describe}, ${b.describe}]`,
    parts: [a, b],
    test(value, at, problems) {
      if (!Array.isArray(value) || value.length !== 2) return void problems.push({ path: at, problem: `should be an array of two, not ${kindOf(value)}` });
      a.test(value[0], `${at}[0]`, problems);
      b.test(value[1], `${at}[1]`, problems);
    },
    fill: (value) => [a.fill((value as unknown[])[0]), b.fill((value as unknown[])[1])],
  };
}

/** An object whose keys are any strings, each value of one shape. */
export function record<T>(shape: Shape<T>): Shape<Record<string, T>> {
  return {
    describe: `Record<string, ${shape.describe}>`,
    parts: [shape],
    test(value, at, problems) {
      if (kindOf(value) !== "an object") return void problems.push({ path: at, problem: `should be an object, not ${kindOf(value)}` });
      for (const [key, item] of Object.entries(value as object)) shape.test(item, `${at}.${key}`, problems);
    },
    fill: (value) => Object.fromEntries(Object.entries(value as object).map(([key, item]) => [key, shape.fill(item)])),
  };
}

export function optional<T, P = unknown>(shape: Shape<T>, fallback: (parent: P) => T, says: string, { extension = false } = {}): Optional<T, P> {
  return { kind: "optional", shape, fallback, says, extension };
}

export function absent<T>(shape: Shape<T>): Absent<T> {
  return { kind: "absent", shape };
}

/** The shape of an object of type T, named `name` in the docs, with a shape for each of its fields. */
export function object<T>(name: string, fields: Fields<T>): ObjectShape<T> {
  const entries = Object.entries(fields) as Array<[string, Field<unknown, T> | Absent<unknown>]>;
  // An object named only by its fields ("{ platform, at }") is written out in full where it is used.
  const inline = `{ ${entries.map(([key, field]) => ("kind" in field ? `${key}?: ${field.shape.describe}` : `${key}: ${field.describe}`)).join("; ")} }`;
  return {
    describe: name.startsWith("{") ? inline : name,
    name,
    fields: fields as Record<string, Field<unknown, T> | Absent<unknown>>,
    parts: entries.map(([, field]) => ("kind" in field ? field.shape : field)),
    test(value, at, problems) {
      if (kindOf(value) !== "an object") return void problems.push({ path: at, problem: `should be ${name}, an object, not ${kindOf(value)}` });
      const object = value as Record<string, unknown>;
      for (const [key, field] of entries) {
        const there = object[key];
        const path = at ? `${at}.${key}` : key;
        if ("kind" in field) {
          // A field that may be left out is also left out by a null, unless null is one of its values.
          if (there === undefined || (there === null && field.kind === "optional" && !acceptsNull(field.shape))) continue;
          field.shape.test(there, path, problems);
        } else if (there === undefined) problems.push({ path, problem: "is missing" });
        else field.test(there, path, problems);
      }
    },
    fill(value) {
      const object = value as Record<string, unknown>;
      const filled: Record<string, unknown> = { ...object };
      // Every field the backend sent first, so an optional one's fallback may read any of them (and the required ones).
      for (const [key, field] of entries) {
        const there = object[key];
        if ("kind" in field) {
          if (there === undefined || (there === null && field.kind === "optional" && !acceptsNull(field.shape))) delete filled[key];
          else filled[key] = field.shape.fill(there);
        } else filled[key] = field.fill(there);
      }
      for (const [key, field] of entries) {
        if ("kind" in field && field.kind === "optional" && !(key in filled)) filled[key] = field.fallback(filled as T);
      }
      return filled as T;
    },
  };
}

export interface ObjectShape<T> extends Shape<T> {
  readonly name: string;
  readonly fields: Record<string, Field<unknown, T> | Absent<unknown>>;
}

const acceptsNull = (shape: AnyShape) => {
  const problems: Problem[] = [];
  shape.test(null, "", problems);
  return problems.length === 0;
};

/** What is wrong with `value` as `shape`, by path; none when it fits. */
export function problemsOf(shape: AnyShape, value: unknown): Problem[] {
  const problems: Problem[] = [];
  shape.test(value, "", problems);
  return problems.map((p) => ({ ...p, path: p.path || "(the answer)" }));
}
