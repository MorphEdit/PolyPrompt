// Fake `claude` that never exits; writes its pid to $FIXTURE_LOG first.
import { writeFileSync } from 'node:fs';
if (process.env.FIXTURE_LOG) writeFileSync(process.env.FIXTURE_LOG, String(process.pid));
setInterval(() => {}, 1000);
