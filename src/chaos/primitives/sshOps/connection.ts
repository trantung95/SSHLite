import { PrimitiveOp } from '../../ChaosTypes';

export const connectionPrimitives: PrimitiveOp[] = [
  {
    name: 'connect',
    surface: 'sshOps',
    weight: 1,
    requiresConnected: false,
    generateParams: () => ({}),
    async execute() {
      // Marker only — actual handshake is owned by the engine, which opens the
      // shared connection before any chain runs. This op exists so chains can
      // reference connect/disconnect/dispose by name and the registry covers it.
    },
  },
  {
    name: 'disconnect',
    surface: 'sshOps',
    weight: 1,
    requiresConnected: true,
    generateParams: () => ({}),
    async execute(conn) {
      await conn.disconnect();
    },
  },
  {
    name: 'dispose',
    surface: 'sshOps',
    weight: 1,
    requiresConnected: true,
    generateParams: () => ({}),
    async execute(conn) {
      conn.dispose();
    },
  },
];
