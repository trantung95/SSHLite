/**
 * Chaos Engine - Logger
 *
 * Writes structured JSONL results to logs/chaos-results.jsonl. Each line is
 * one Session run, replay-grade detail. Append-only.
 */

import * as fs from 'fs';
import * as path from 'path';
import { RunResult } from './ChaosTypes';

export class ChaosLogger {
  constructor(private outPath: string) {
    fs.mkdirSync(path.dirname(this.outPath), { recursive: true });
  }

  write(result: RunResult): void {
    fs.appendFileSync(this.outPath, JSON.stringify(result) + '\n');
  }
}
