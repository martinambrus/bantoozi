// Copies the API's output to the file named by E2E_API_LOG_FILE (and to stdout), turning each JSON
// log line into its plain `msg`, so the spec can match "Setup token ...: <token>" up to the line end.
import { createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';

const file = createWriteStream(process.argv[2] ?? '', { flags: 'a' });
for await (const line of createInterface({ input: process.stdin })) {
  let text = line;
  try {
    const parsed = JSON.parse(line);
    if (typeof parsed?.msg === 'string') text = parsed.msg;
  } catch {
    // not JSON: keep the line as it is
  }
  file.write(`${text}\n`);
  process.stdout.write(`${line}\n`);
}
