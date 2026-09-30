// JSONL ledger: one line appended per agent payment (settled / refused / failed).
import fs from 'node:fs';
import path from 'node:path';

export function createLedger(filePath) {
  const entries = [];
  if (filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (fs.existsSync(filePath)) for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) if (line.trim()) entries.push(JSON.parse(line));
  }
  return {
    append(entry) {
      const row = { ts: new Date().toISOString(), ...entry };
      entries.push(row);
      if (filePath) fs.appendFileSync(filePath, JSON.stringify(row) + '\n');
      return row;
    },
    all() { return entries.slice(); },
    clear() { entries.length = 0; if (filePath && fs.existsSync(filePath)) fs.writeFileSync(filePath, ''); },
  };
}
