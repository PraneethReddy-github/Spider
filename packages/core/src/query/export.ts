import type { SubGraph } from '@spider/shared';

const STRUCTURAL = new Set(['contains', 'member_of']);

/** Graphviz DOT of every node and every relationship edge (containment omitted). */
export function toDot(sg: SubGraph): string {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const lines = ['digraph spider {', '  rankdir=LR;', '  node [shape=box, fontname="Helvetica"];'];
  for (const n of sg.nodes) lines.push(`  "${n.id}" [label="${esc(n.name)}", kind="${n.kind}"];`);
  for (const e of sg.edges) if (!STRUCTURAL.has(e.kind)) lines.push(`  "${e.src}" -> "${e.dst}" [label="${e.kind}"];`);
  lines.push('}');
  return lines.join('\n');
}

/** GraphML with node kind/name/qname/file/parent and edge kind/weight/confidence attributes. */
export function toGraphML(sg: SubGraph): string {
  const esc = (s: unknown) =>
    String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  const data = (k: string, v: unknown) => (v === undefined ? '' : `<data key="${k}">${esc(v)}</data>`);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<graphml xmlns="http://graphml.graphdrawing.org/xmlns">',
    '  <key id="kind" for="node" attr.name="kind" attr.type="string"/>',
    '  <key id="name" for="node" attr.name="name" attr.type="string"/>',
    '  <key id="qname" for="node" attr.name="qname" attr.type="string"/>',
    '  <key id="file" for="node" attr.name="file" attr.type="string"/>',
    '  <key id="parent" for="node" attr.name="parent" attr.type="string"/>',
    '  <key id="ekind" for="edge" attr.name="kind" attr.type="string"/>',
    '  <key id="weight" for="edge" attr.name="weight" attr.type="double"/>',
    '  <key id="confidence" for="edge" attr.name="confidence" attr.type="double"/>',
    '  <graph id="spider" edgedefault="directed">',
  ];
  for (const n of sg.nodes)
    lines.push(
      `    <node id="${esc(n.id)}">${data('kind', n.kind)}${data('name', n.name)}${data('qname', n.qname)}${data('file', n.file)}${data('parent', n.parentId)}</node>`,
    );
  for (const e of sg.edges)
    if (!STRUCTURAL.has(e.kind))
      lines.push(
        `    <edge id="${esc(e.id)}" source="${esc(e.src)}" target="${esc(e.dst)}">${data('ekind', e.kind)}${data('weight', e.weight)}${data('confidence', e.confidence)}</edge>`,
      );
  lines.push('  </graph>', '</graphml>');
  return lines.join('\n');
}
