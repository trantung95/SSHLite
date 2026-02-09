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

export const ALL_SCENARIOS: ScenarioDefinition[] = [
  ...connectionLifecycleScenarios,
  ...fileOperationsScenarios,
  ...commandGuardScenarios,
  ...serverMonitorScenarios,
  ...concurrentOperationsScenarios,
  ...errorPathsScenarios,
  ...mixedWorkflowsScenarios,
];

export {
  connectionLifecycleScenarios,
  fileOperationsScenarios,
  commandGuardScenarios,
  serverMonitorScenarios,
  concurrentOperationsScenarios,
  errorPathsScenarios,
  mixedWorkflowsScenarios,
};
