/** Dependency-free SVG charts (server-rendered). */
export function BarChart({ data, height = 160, color = "#0369a1", label }: { data: { x: string; y: number }[]; height?: number; color?: string; label?: (v: number) => string }) {
  const w = Math.max(320, data.length * 22);
  const max = Math.max(1, ...data.map((d) => d.y));
  const bw = w / Math.max(1, data.length);
  return (
    <svg viewBox={`0 0 ${w} ${height + 24}`} className="w-full" role="img" style={{ direction: "ltr" }}>
      {data.map((d, i) => {
        const h = (d.y / max) * height;
        return (
          <g key={i}>
            <rect x={i * bw + 3} y={height - h} width={bw - 6} height={h} rx={3} fill={color} opacity={0.85}>
              <title>{`${d.x}: ${label ? label(d.y) : d.y}`}</title>
            </rect>
            {(data.length <= 12 || i % Math.ceil(data.length / 10) === 0) && <text x={i * bw + bw / 2} y={height + 16} fontSize={9} textAnchor="middle" fill="#64748b">{d.x.slice(5)}</text>}
          </g>
        );
      })}
      <line x1={0} x2={w} y1={height} y2={height} stroke="#cbd5e1" />
    </svg>
  );
}

export function Donut({ parts, size = 140 }: { parts: { label: string; value: number; color: string }[]; size?: number }) {
  const total = parts.reduce((s, p) => s + p.value, 0) || 1;
  const r = size / 2 - 12, c = 2 * Math.PI * r;
  let acc = 0;
  return (
    <div className="flex items-center gap-4">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img">
        {parts.map((p, i) => {
          const len = (p.value / total) * c;
          const el = <circle key={i} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={p.color} strokeWidth={18} strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-acc} transform={`rotate(-90 ${size / 2} ${size / 2})`}><title>{`${p.label}: ${p.value}`}</title></circle>;
          acc += len;
          return el;
        })}
      </svg>
      <ul className="space-y-1 text-xs">
        {parts.map((p, i) => <li key={i} className="flex items-center gap-2"><span className="inline-block h-3 w-3 rounded-sm" style={{ background: p.color }} />{p.label} <span dir="ltr" className="text-slate-500">{Math.round((p.value / total) * 100)}%</span></li>)}
      </ul>
    </div>
  );
}
