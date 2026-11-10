// Reading a protobuf message without its schema, as the apps' databases keep
// some records (WeChat's contact remarks and member lists, WhatsApp's call
// records): its fields by number, each a varint (a number) or a
// length-delimited value (its bytes: text, or a message inside it, which this
// reads the same way). The caller knows which field is which.

export type ProtobufValue = number | Uint8Array;

/**
 * Every field of a protobuf message, by number, each time it occurs, in order: varints as numbers, length-delimited
 * ones as their bytes; fixed-width ones (doubles, floats) are passed over. Null if it is not one.
 */
export function protobufMessage(bytes: Uint8Array): Map<number, ProtobufValue[]> | null {
  const fields = new Map<number, ProtobufValue[]>();
  let at = 0;
  const varint = (): number => {
    let value = 0;
    for (let shift = 0; ; shift += 7) {
      if (at >= bytes.length || shift > 63) throw new RangeError("varint runs past the end");
      const byte = bytes[at++];
      value += (byte & 0x7f) * 2 ** shift;
      if (!(byte & 0x80)) return value;
    }
  };
  try {
    while (at < bytes.length) {
      const key = varint();
      const field = Math.floor(key / 8);
      const wire = key % 8;
      let value: ProtobufValue | undefined;
      if (wire === 0) value = varint();
      else if (wire === 2) {
        const length = varint();
        if (at + length > bytes.length) return null;
        value = bytes.subarray(at, at + length);
        at += length;
      } else if (wire === 1) at += 8;
      else if (wire === 5) at += 4;
      else return null;
      if (at > bytes.length) return null;
      if (value !== undefined) fields.set(field, [...(fields.get(field) ?? []), value]);
    }
  } catch {
    return null;
  }
  return fields;
}

/** The message a protobuf field holds (its first occurrence), read as one; null when the field is absent or is not one. */
export function protobufInner(fields: Map<number, ProtobufValue[]> | null, field: number): Map<number, ProtobufValue[]> | null {
  const value = fields?.get(field)?.[0];
  return value instanceof Uint8Array ? protobufMessage(value) : null;
}

/** A varint field's value (its first occurrence), or undefined when the field is absent or holds bytes. */
export function protobufNumber(fields: Map<number, ProtobufValue[]> | null, field: number): number | undefined {
  const value = fields?.get(field)?.[0];
  return typeof value === "number" ? value : undefined;
}

/** A length-delimited field's value (its first occurrence) as UTF-8 text, or undefined when absent or a varint. */
export function protobufText(fields: Map<number, ProtobufValue[]> | null, field: number): string | undefined {
  const value = fields?.get(field)?.[0];
  return value instanceof Uint8Array ? Buffer.from(value).toString("utf8") : undefined;
}
