/** Node and edge kinds (own module so `schemas.ts` can use them without an import cycle). */

export type NodeKind =
  | 'repository'
  | 'subsystem'
  | 'package'
  | 'directory'
  | 'file'
  | 'module'
  | 'namespace'
  | 'class'
  | 'function'
  | 'method'
  | 'variable'
  | 'type'
  | 'endpoint'
  | 'external'
  | 'datastore'
  | 'config';

export type EdgeKind =
  | 'contains'
  | 'imports'
  | 'exports'
  | 'calls'
  | 'instantiates'
  | 'extends'
  | 'implements'
  | 'references'
  | 'exposes'
  | 'depends_on'
  | 'reads'
  | 'writes'
  | 'configures'
  | 'member_of'
  | 'dep_aggregate';

export const NODE_KINDS: NodeKind[] = [
  'repository',
  'subsystem',
  'package',
  'directory',
  'file',
  'module',
  'namespace',
  'class',
  'function',
  'method',
  'variable',
  'type',
  'endpoint',
  'external',
  'datastore',
  'config',
];

export const EDGE_KINDS: EdgeKind[] = [
  'contains',
  'imports',
  'exports',
  'calls',
  'instantiates',
  'extends',
  'implements',
  'references',
  'exposes',
  'depends_on',
  'reads',
  'writes',
  'configures',
  'member_of',
  'dep_aggregate',
];
