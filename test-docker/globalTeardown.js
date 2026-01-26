"use strict";
/**
 * Jest Global Teardown for Docker SSH Tests
 *
 * Automatically stops and removes Docker containers after tests complete.
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
exports.default = globalTeardown;
const child_process_1 = require("child_process");
const path = __importStar(require("path"));
const COMPOSE_FILE = path.join(__dirname, 'docker-compose.yml');
async function globalTeardown() {
    console.log('\n[Docker Teardown] Stopping SSH test containers...');
    try {
        (0, child_process_1.execSync)(`docker compose -f "${COMPOSE_FILE}" down`, {
            stdio: 'pipe',
            timeout: 30000,
        });
        console.log('[Docker Teardown] Containers stopped and removed.');
    }
    catch (err) {
        console.error('[Docker Teardown] Failed to stop containers:', err.stderr?.toString() || err.message);
        // Don't throw — teardown failures shouldn't fail the test run
    }
}
//# sourceMappingURL=globalTeardown.js.map