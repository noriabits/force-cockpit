import * as fs from 'fs';
import * as path from 'path';
import xmlFormat from 'xml-formatter';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

type XmlDoc = ReturnType<DOMParser['parseFromString']>;
type XmlElement = ReturnType<XmlDoc['createElement']>;
type XmlRoot = XmlDoc | XmlElement;

export const xml = {
  parse(filePath: string): XmlDoc {
    const doc = new DOMParser().parseFromString(
      fs.readFileSync(path.resolve(filePath), 'utf8'),
      'text/xml',
    );
    const parseError = doc.getElementsByTagName('parsererror')[0];
    if (parseError) throw new Error(`Failed to parse ${filePath}: ${parseError.textContent}`);
    return doc;
  },

  save(doc: XmlDoc, filePath: string): void {
    const out = new XMLSerializer().serializeToString(doc);
    fs.writeFileSync(path.resolve(filePath), xmlFormat(out, { collapseContent: true }), 'utf8');
  },

  element(doc: XmlDoc, tag: string, children: Record<string, string>): XmlElement {
    const el = doc.createElement(tag);
    Object.entries(children).forEach(([childTag, text]) => {
      const child = doc.createElement(childTag);
      child.appendChild(doc.createTextNode(text));
      el.appendChild(child);
    });
    return el;
  },

  append(
    doc: XmlDoc,
    parentTag: string,
    newNode: XmlElement,
    opts: { matchFn?: (el: XmlElement) => boolean; beforeTag?: string } = {},
  ): boolean {
    const parents = Array.from(doc.getElementsByTagName(parentTag)) as XmlElement[];
    const target = opts.matchFn ? parents.find(opts.matchFn) : parents[parents.length - 1];
    if (!target) return false;
    const before = opts.beforeTag ? target.getElementsByTagName(opts.beforeTag)[0] : null;
    if (before) {
      const prev = before.previousSibling;
      const insertPoint =
        prev && prev.nodeType === 3 && /^\s*$/.test(prev.nodeValue ?? '') ? prev : before;
      target.insertBefore(newNode, insertPoint);
    } else {
      target.appendChild(newNode);
    }
    return true;
  },

  findParent(doc: XmlDoc, parentTag: string, childTag: string, text: string): XmlElement | null {
    const parents = Array.from(doc.getElementsByTagName(parentTag)) as XmlElement[];
    return (
      parents.find((p) =>
        Array.from(p.getElementsByTagName(childTag)).some((c) => c.textContent === text),
      ) ?? null
    );
  },

  getText(root: XmlRoot, tag: string): string | null {
    const node = root.getElementsByTagName(tag)[0];
    return node ? node.textContent : null;
  },

  setText(root: XmlRoot, tag: string, value: string): boolean {
    const node = root.getElementsByTagName(tag)[0];
    if (!node) return false;
    while (node.firstChild) node.removeChild(node.firstChild);
    node.appendChild(node.ownerDocument!.createTextNode(value));
    return true;
  },
};
