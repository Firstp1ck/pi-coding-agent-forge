import { fail } from "../errors.ts";
import type { OoxmlPackage } from "../ooxml/package.ts";
import { parseXml } from "../ooxml/xml.ts";

export function preflightVbaPackage(pkg: OoxmlPackage): void {
  if (pkg.relationships.some((rel) => /\/(?:xlMacrosheet|xlIntlMacrosheet)$/i.test(rel.type)) || [...pkg.contentTypes.values()].some((type) => /macrosheet/i.test(type))) fail("UNSUPPORTED_FEATURE", "Excel 4.0 macro sheets are not supported by VBA tools.");
  // Excel can refresh these parts on open, including during the pre-approval inventory.
  for (const [part, entry] of pkg.archive.entries) {
    const type = pkg.contentTypeFor(part) ?? "";
    if (!/(?:connections|pivotCache|queryTable)/i.test(`${part} ${type}`) || (!/\.xml$/i.test(part) && !/xml/i.test(type))) continue;
    const document = parseXml(entry.data, part, pkg.archive.limits.maxXmlBytes);
    const nodes = document.getElementsByTagName("*");
    for (let index = 0; index < nodes.length; index++) {
      // Match by local name so a namespace-prefixed refreshOnLoad cannot slip past the check.
      const attributes = nodes.item(index)!.attributes;
      for (let attr = 0; attr < attributes.length; attr++) {
        const attribute = attributes.item(attr)!;
        if ((attribute.localName ?? attribute.name) === "refreshOnLoad" && /^(?:1|true)$/i.test(attribute.value.trim())) fail("UNSUPPORTED_FEATURE", `Refresh-on-load is not supported by VBA tools: ${part}`);
      }
    }
  }
}
