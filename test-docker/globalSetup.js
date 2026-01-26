"use strict";
/**
 * Jest Global Setup for Docker SSH Tests
 *
 * Automatically starts Docker containers and waits for SSH
 * to become available on all 3 servers before tests run.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = globalSetup;
const child_process_1 = require("child_process");
const ssh2_1 = require("ssh2");
const path = __importStar(require("path"));
const COMPOSE_FILE = path.join(__dirname, 'docker-compose.yml');
const SERVERS = [
    { host: '127.0.0.1', port: 2201, username: 'testuser', password: 'testpass' },
    { host: '127.0.0.1', port: 2202, username: 'testuser', password: 'testpass' },
    { host: '127.0.0.1', port: 2203, username: 'admin', password: 'adminpass' },
];
/** Try to connect to an SSH server, resolve true if successful */
function tryConnect(config) {
    return new Promise((resolve) => {
        const client = new ssh2_1.Client();
        const timeout = setTimeout(() => {
            client.end();
            resolve(false);
        }, 3000);
        client.on('ready', () => {
            clearTimeout(timeout);
            client.end();
            resolve(true);
        });
        client.on('error', () => {
            clearTimeout(timeout);
            resolve(false);
        });
        client.connect({
            host: config.host,
            port: config.port,
            username: config.username,
            password: config.password,
            readyTimeout: 3000,
        });
    });
}
/** Wait until SSH is available on a server, with retries */
async function waitForSSH(config, maxRetries = 30, delayMs = 1000) {
    for (let i = 0; i < maxRetries; i++) {
        const ok = await tryConnect(config);
        if (ok) {
            return;
        }
        await new Promise((r) => setTimeout(r, delayMs));
    }
    throw new Error(`SSH not available on ${config.host}:${config.port} after ${maxRetries} retries`);
}
async function globalSetup() {
    console.log('\n[Docker Setup] Starting SSH test containers...');
    // Start containers
    try {
        (0, child_process_1.execSync)(`docker compose -f "${COMPOSE_FILE}" up -d --build`, {
            stdio: 'pipe',
            timeout: 120000,
        });
    }
    catch (err) {
        console.error('[Docker Setup] Failed to start containers:', err.stderr?.toString() || err.message);
        throw err;
    }
    console.log('[Docker Setup] Containers started. Waiting for SSH readiness...');
    // Wait for all 3 servers to accept SSH connections
    await Promise.all(SERVERS.map(async (server, i) => {
        await waitForSSH(server);
        console.log(`[Docker Setup] Server ${i + 1} (port ${server.port}) ready`);
    }));
    console.log('[Docker Setup] All servers ready.\n');
}
//# sourceMappingURL=globalSetup.js.map