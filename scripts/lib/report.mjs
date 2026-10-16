import fs from 'node:fs';

// Collects human-readable lines for the console and the GitHub Actions job summary.
export class Report {
  constructor(title) { this.title = title; this.lines = []; this.errors = 0; this.changed = false; }
  add(line) { this.lines.push(line); console.log(line.replace(/[*`]/g, '')); }
  error(line) { this.errors++; this.add(`❌ ${line}`); }
  flush() {
    const out = [`## ${this.title}`, '', ...(this.lines.length ? this.lines.map((l) => `- ${l}`) : ['- Nothing to do.']), ''].join('\n');
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, out + '\n');
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `errors=${this.errors}\nchanged=${this.changed}\n`);
  }
}

export function describeResult(res, fileLabel) {
  const r = res.route;
  switch (res.status) {
    case 'duplicate':
      return `${fileLabel}: duplicate of \`${res.activity.id}\` in route \`${r.id}\` (${res.match.reason}) — skipped`;
    case 'joined':
      return `${fileLabel}: joined group ride \`${r.id}\` "${r.title}" — riders: ${r.participants.join(', ')} (${res.match.reason}, together ${Math.round((res.match.metrics?.together_ratio ?? 0) * 100)}%)`;
    case 'new':
      return `${fileLabel}: new route \`${r.id}\` "${r.title}" — ${r.distance_km ?? '?'} km, +${r.elevation_gain_m ?? '?'} m`;
    case 'new-needs-review':
      return `${fileLabel}: new route \`${r.id}\` "${r.title}" — **needs review**: ${res.reviews
        .map((v) => `possible match with \`${v.routes[1]}\` (${v.reason}). Merge with the "Review routes" workflow: command=merge, route=${r.id}, into=${v.routes[1]} — or command=dismiss, target=${v.id}`)
        .join('; ')}`;
    default:
      return `${fileLabel}: ${res.status}`;
  }
}
