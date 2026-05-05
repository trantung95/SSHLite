/**
 * Chaos Scenario Registry
 *
 * All scenarios are registered here and exported as a flat array.
 */

import { ScenarioDefinition } from '../ChaosConfig';
import { connectionLifecycleScenarios } from './connection-lifecycle';
import { fileOperationsScenarios } from './file-operations';
import { commandGuardScenarios } from './command-guard';
import { serverMonitorScenarios } from './server-monitor';
import { concurrentOperationsScenarios } from './concurrent-operations';
import { errorPathsScenarios } from './error-paths';
import { mixedWorkflowsScenarios } from './mixed-workflows';
import { sshToolsScenarios } from './ssh-tools';
import { sshToolsKeyScenarios } from './ssh-tools-keys';
import { channelSemaphoreScenarios } from './channel-semaphore';
import { portForwardScenarios } from './port-forward';

export const ALL_SCENARIOS: ScenarioDefinition[] = [
  ...connectionLifecycleScenarios,
  ...fileOperationsScenarios,
  ...commandGuardScenarios,
  ...serverMonitorScenarios,
  ...concurrentOperationsScenarios,
  ...errorPathsScenarios,
  ...mixedWorkflowsScenarios,
  ...sshToolsScenarios,
  ...sshToolsKeyScenarios,
  ...channelSemaphoreScenarios,
  ...portForwardScenarios,
];

export {
  connectionLifecycleScenarios,
  fileOperationsScenarios,
  commandGuardScenarios,
  serverMonitorScenarios,
  concurrentOperationsScenarios,
  errorPathsScenarios,
  mixedWorkflowsScenarios,
  sshToolsScenarios,
  sshToolsKeyScenarios,
  channelSemaphoreScenarios,
  portForwardScenarios,
};
