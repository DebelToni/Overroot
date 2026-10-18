// Reuse Pi Chat's conservative live/suspended-writer detection, without starting its server.
import { runningSessionOwners } from '/home/xaj/pi-chat/history.mjs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
console.log(JSON.stringify(await runningSessionOwners(JSON.parse(Buffer.concat(chunks).toString()))));
