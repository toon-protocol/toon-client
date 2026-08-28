/**
 * Talking to the terminal: reading a body from a pipe, and reading a secret
 * without putting it on screen.
 *
 * All of it is isolated here for one reason — every function below touches a
 * real file descriptor, which is exactly what a unit test cannot do. The
 * commands take these as injected dependencies, so what gets exercised in tests
 * is the *decision* (which source a password came from, whether the body came
 * from stdin) rather than the plumbing.
 *
 * Prompts are written to **stderr**, not stdout. Under `--json` stdout carries
 * one JSON document and nothing else, and a prompt is not part of the answer.
 */

/** Read stdin to EOF as bytes. Used for `--body -` and for `init --import`. */
export async function readStdin(
  stream: NodeJS.ReadableStream = process.stdin
): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/** Read stdin to EOF and take its first line, newline stripped. */
export async function readStdinLine(
  stream: NodeJS.ReadableStream = process.stdin
): Promise<string> {
  const bytes = await readStdin(stream);
  const first = Buffer.from(bytes).toString('utf8').split('\n')[0];
  return first === undefined ? '' : first.replace(/\r$/, '');
}

/** Is this process attached to a terminal that can prompt? */
export function isInteractive(input: NodeJS.ReadStream = process.stdin): boolean {
  return input.isTTY === true && typeof input.setRawMode === 'function';
}

/**
 * Control characters the raw-mode prompt has to interpret itself, written as
 * code points rather than literals so they survive every editor and diff.
 */
const CTRL_C = String.fromCharCode(3);
const CTRL_D = String.fromCharCode(4);
const BACKSPACE = String.fromCharCode(8);
const DELETE = String.fromCharCode(127);

/**
 * Prompt for a secret with the terminal's echo turned off.
 *
 * Raw mode rather than `readline`: `readline` echoes as it reads and there is no
 * supported way to stop it, so the password would appear on the operator's
 * screen and in whatever is recording that screen. In raw mode the characters
 * arrive here and nowhere else, and nothing is written back.
 *
 * Ctrl-C is handled explicitly because raw mode means the terminal no longer
 * turns it into SIGINT: a prompt that ignored it would be a prompt you could not
 * escape.
 */
export function promptHidden(
  message: string,
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WritableStream = process.stderr
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    output.write(message);
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');

    let buffer = '';
    const finish = (fn: () => void): void => {
      input.removeListener('data', onData);
      input.setRawMode(wasRaw);
      input.pause();
      output.write('\n');
      fn();
    };

    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n' || char === CTRL_D) {
          finish(() => {
            resolve(buffer);
          });
          return;
        }
        if (char === CTRL_C) {
          finish(() => {
            reject(new Error('cancelled'));
          });
          return;
        }
        if (char === DELETE || char === BACKSPACE) {
          buffer = buffer.slice(0, -1);
          continue;
        }
        buffer += char;
      }
    };

    input.on('data', onData);
  });
}
