import { PrimitiveOp } from '../../ChaosTypes';
import { CredentialService } from '../../../services/CredentialService';
import { SeededRandom } from '../../chaos-helpers';

function fakeHost(rng: SeededRandom): string {
  return `chaos-host-${rng.int(0, 999)}`;
}

function fakeCredId(rng: SeededRandom): string {
  return `chaos-cred-${rng.int(0, 0xffff).toString(16)}`;
}

export const credentialOps: PrimitiveOp[] = [
  {
    name: 'saveCredential',
    surface: 'serviceOps',
    weight: 1,
    requiresConnected: false,
    generateParams: (rng) => ({
      host: fakeHost(rng),
      credId: fakeCredId(rng),
      secret: `pw-${rng.int(0, 0xffff).toString(16)}`,
    }),
    async execute(_conn, params) {
      const svc = CredentialService.getInstance();
      try {
        if (typeof (svc as any).setSessionCredential === 'function') {
          (svc as any).setSessionCredential(params.host as string, params.credId as string, params.secret as string);
        }
      } catch { /* ignore */ }
    },
  },
  {
    name: 'retrieveCredential',
    surface: 'serviceOps',
    weight: 1,
    requiresConnected: false,
    generateParams: (rng) => ({
      host: fakeHost(rng),
      credId: fakeCredId(rng),
    }),
    async execute(_conn, params) {
      const svc = CredentialService.getInstance();
      try {
        if (typeof (svc as any).getCredentialSecret === 'function') {
          await (svc as any).getCredentialSecret(params.host as string, params.credId as string);
        }
      } catch { /* may not exist */ }
    },
  },
  {
    name: 'deleteCredential',
    surface: 'serviceOps',
    weight: 1,
    requiresConnected: false,
    generateParams: (rng) => ({
      host: fakeHost(rng),
      credId: fakeCredId(rng),
    }),
    async execute(_conn, params) {
      const svc = CredentialService.getInstance();
      try {
        if (typeof (svc as any).deleteCredential === 'function') {
          await (svc as any).deleteCredential(params.host as string, params.credId as string);
        }
      } catch { /* may not exist */ }
    },
  },
];
