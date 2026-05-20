import { PrimitiveOp } from '../ChaosTypes';
import { connectionPrimitives } from './sshOps/connection';
import { runPrimitives } from './sshOps/run';
import { filePrimitives } from './sshOps/file';
import { sudoPrimitives } from './sshOps/sudo';
import { credentialOps } from './serviceOps/credentialOps';
import { fileServiceOps } from './serviceOps/fileServiceOps';

export const PRIMITIVES: PrimitiveOp[] = [
  ...connectionPrimitives,
  ...runPrimitives,
  ...filePrimitives,
  ...sudoPrimitives,
  ...credentialOps,
  ...fileServiceOps,
];

const byName = new Map(PRIMITIVES.map(p => [p.name, p]));

export function primitiveByName(name: string): PrimitiveOp | undefined {
  return byName.get(name);
}

export const PRIMITIVE_NAMES = new Set(PRIMITIVES.map(p => p.name));
