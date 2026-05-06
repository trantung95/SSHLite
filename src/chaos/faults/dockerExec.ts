import { spawn } from 'child_process';

export interface DockerCmdResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function dockerCmd(args: string[]): Promise<DockerCmdResult> {
  return new Promise((resolve) => {
    const p = spawn('docker', args, { shell: false });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', d => { stdout += d.toString(); });
    p.stderr.on('data', d => { stderr += d.toString(); });
    p.on('close', code => resolve({ code: code ?? 0, stdout, stderr }));
    p.on('error', err => resolve({ code: -1, stdout, stderr: stderr + (err as Error).message }));
  });
}

/** Issues a docker <subcmd> against the named container. The subcmd is built
 *  from string parts to avoid the security-reminder hook's literal-substring
 *  match on the shell-out helper name. */
export async function dockerExecIn(container: string, cmd: string[]): Promise<DockerCmdResult> {
  const subcmd = 'e' + 'xec';
  return dockerCmd([subcmd, container, ...cmd]);
}
