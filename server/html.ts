// What more than one reader of other sites' pages needs of HTML (an inspiration's preview, the Shopping module's
// storefronts; the SDK lends it to the modules).

/** HTML's character references, as a page's text has them. */
export function decodeEntities(value: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const point = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
    }
    return named[code.toLowerCase()] ?? whole;
  });
}
