import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseRange, sendRanged } from "./byteRanges.ts";

describe("parseRange", () => {
  it("reads one byte range, and ignores what it can't use", () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange("bytes=0-0", 100)).toEqual({ start: 0, end: 0 });
    expect(parseRange("bytes=10-", 100)).toEqual({ start: 10, end: 99 });
    expect(parseRange("bytes=90-500", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-500", 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=0-1,5-6", 100)).toBeNull();
    expect(parseRange("items=0-1", 100)).toBeNull();
    expect(parseRange("bytes=-", 100)).toBeNull();
    expect(parseRange("bytes=100-", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=5-4", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=-0", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=0-", 0)).toBe("unsatisfiable");
  });
});

describe("sendRanged", () => {
  let dir: string;
  let base: string;
  const server = createServer((req, res) => void sendRanged(req, res, join(dir, "file.bin"), 10, { "content-type": "application/octet-stream" }));

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "byte-ranges-"));
    await writeFile(join(dir, "file.bin"), "0123456789");
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });

  it("answers the whole file, the one range asked for, and 416 for a range outside it", async () => {
    const whole = await fetch(base);
    expect(whole.status).toBe(200);
    expect(whole.headers.get("accept-ranges")).toBe("bytes");
    expect(await whole.text()).toBe("0123456789");

    const part = await fetch(base, { headers: { range: "bytes=2-4" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 2-4/10");
    expect(part.headers.get("content-length")).toBe("3");
    expect(await part.text()).toBe("234");

    const outside = await fetch(base, { headers: { range: "bytes=20-" } });
    expect(outside.status).toBe(416);
    expect(outside.headers.get("content-range")).toBe("bytes */10");

    const head = await fetch(base, { method: "HEAD", headers: { range: "bytes=-3" } });
    expect(head.status).toBe(206);
    expect(head.headers.get("content-range")).toBe("bytes 7-9/10");
  });
});
