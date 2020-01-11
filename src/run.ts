import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';

import { ID } from './types';
import { EditorUtil } from './util/editor';
import { ModuleUtil } from './util/module';
import { VSCodeUtil } from './vscode';
import { Util } from './util/util';

const log = Util.log.bind(null, 'RUN');

export class ScriptRunner {

  static proc: cp.ChildProcess;
  static channel: vscode.OutputChannel;

  static sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  /**
   * Prepare output
   */
  static prepareOutput(doc: vscode.TextDocument, args: (string | undefined)[] = []) {
    const mod = EditorUtil.getModuleFromShebang(doc)!;

    if (!this.channel) {
      this.channel = vscode.window.createOutputChannel(`@${ID}`);
    }

    this.channel.clear();

    const { fileName } = doc;
    const relativeFile = VSCodeUtil.resolveToRelativePath(fileName);

    args = args.filter(x => !!x);

    [
      `[${new Date().toISOString().split('.')[0]}] Running ${relativeFile}${args.length ? ` with ${args.join(' ')}` : ''} via ${mod.full}`,
      '',
      'Output',
      '-'.repeat(30)
    ].forEach(l => this.channel.appendLine(l));

    this.channel.show(true);
  }

  /**
   * Output line
   */
  static append(chunk: string | Buffer) {
    if (typeof chunk === 'string') {
      this.channel.append(chunk);
    } else {
      this.channel.append(chunk.toString('utf8'));
    }
  }

  /**
   * Mark as done
   */
  static appendDone(code?: number) {
    this.append(`\n[DONE] (exit code ${code})\n`);
  }

  /**
   * Kill proc
   */
  static killProc(code?: number) {
    if (this.proc) {
      log('Killing running process', code);
      this.watchProc('off');
      this.proc.kill('SIGKILL');
      Object.defineProperty(this.proc, 'killed', { get() { return true; } });
      this.appendDone(code);
    }
  }

  /**
   * Watch proc
   */
  static watchProc(op: 'on' | 'off') {
    if (this.proc) {
      this.proc[op]('close', this.killProc);
      this.proc.stdout![op]('data', this.append);
      this.proc.stderr![op]('data', this.append);
    }
  }

  /**
   * Launch process
   */
  static launchProcess(doc: vscode.TextDocument) {
    const file = doc.fileName;
    const shebang = EditorUtil.getShebang(doc)!;
    const typedefLoc = EditorUtil.getTypingsPath(doc);
    const cmd = ModuleUtil.getShebangCommand(shebang, typedefLoc);

    const [exe, ...args] = `${cmd} ${file}`.split(' ');
    log('Starting new process', cmd, file);

    this.proc = cp.spawn(exe, args, {
      stdio: 'pipe',
      cwd: VSCodeUtil.resolveToRelativePath()
    });

    this.watchProc('on');

    return (async () => {
      await this.sleep(1000);

      if (!this.proc || this.proc.killed) {
        return;
      }

      // Wait for process to finish
      await vscode.window.withProgress({
        cancellable: true,
        location: vscode.ProgressLocation.Notification,
        title: `Running ${ID} ${file}`
      }, async (_, token) => {
        token.onCancellationRequested(this.killProc.bind(this));

        while (!token.isCancellationRequested && !this.proc.killed && this.proc.stdout?.readable) {
          await this.sleep(100);
        }
      });
    })();
  }

  /**
   * Run script for given document
   */
  static async run(doc: vscode.TextDocument, file?: string) {
    this.killProc();
    await this.prepareOutput(doc, [file]);
    const waiter = this.launchProcess(doc);

    if (file) {
      fs.createReadStream(file).pipe(this.proc.stdin!);
    }

    await waiter;
  }

  /**
   * Activate runner
   */
  static activate(ctx: vscode.ExtensionContext) {
    this.killProc = this.killProc.bind(this);
    this.append = this.append.bind(this);
    this.appendDone = this.appendDone.bind(this);
  }
}