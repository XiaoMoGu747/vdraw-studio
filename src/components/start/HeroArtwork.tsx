export function HeroArtwork() {
  return (
    <svg
      className="hero-art"
      viewBox="0 0 560 400"
      role="img"
      aria-label="矢量图形与化学结构示意"
    >
      <defs>
        <linearGradient id="art-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#edf3ff" />
          <stop offset="0.55" stopColor="#f4f7ff" />
          <stop offset="1" stopColor="#f7fbfa" />
        </linearGradient>
        <linearGradient id="art-stroke" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#3f6df0" />
          <stop offset="1" stopColor="#7c5cf0" />
        </linearGradient>
        <pattern id="art-dots" width="18" height="18" patternUnits="userSpaceOnUse">
          <circle cx="1.2" cy="1.2" r="1.1" fill="#c4d0e8" opacity="0.55" />
        </pattern>
        <filter id="art-shadow" x="-30%" y="-30%" width="160%" height="180%">
          <feDropShadow dx="0" dy="5" stdDeviation="7" floodColor="#1d2a4d" floodOpacity="0.12" />
        </filter>
        <filter id="art-chip-shadow" x="-30%" y="-30%" width="160%" height="180%">
          <feDropShadow dx="0" dy="3" stdDeviation="5" floodColor="#1d2a4d" floodOpacity="0.1" />
        </filter>
      </defs>

      <rect width="560" height="400" rx="24" fill="url(#art-bg)" />
      <rect width="560" height="400" rx="24" fill="url(#art-dots)" opacity="0.55" />
      <rect x="0.5" y="0.5" width="559" height="399" rx="24" fill="none" stroke="#e2e8f5" />

      <g transform="rotate(-7 150 150)">
        <rect x="66" y="108" width="168" height="116" rx="6" fill="#4c7df0" opacity="0.08" />
        <rect
          x="66"
          y="108"
          width="168"
          height="116"
          rx="6"
          fill="none"
          stroke="#3f6df0"
          strokeWidth="1.6"
          opacity="0.55"
        />
      </g>

      <ellipse cx="156" cy="182" rx="66" ry="40" fill="#ffffff" opacity="0.55" />
      <ellipse cx="156" cy="182" rx="66" ry="40" fill="none" stroke="#0f9d8f" strokeWidth="1.6" opacity="0.55" />

      <path
        d="M70 314C122 208 196 336 262 258C304 208 338 214 372 238"
        fill="none"
        stroke="url(#art-stroke)"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <g opacity="0.45" stroke="#7c8db3" strokeWidth="1.1" strokeDasharray="3 4">
        <path d="M70 314L118 266M262 258L318 300M372 238L396 196" />
      </g>
      <g fill="#ffffff" stroke="#3f6df0" strokeWidth="1.7">
        <rect x="64" y="308" width="12" height="12" rx="2" />
        <rect x="256" y="252" width="12" height="12" rx="2" />
        <rect x="366" y="232" width="12" height="12" rx="2" />
        <rect x="390" y="190" width="12" height="12" rx="2" />
      </g>
      <g fill="#ffffff" stroke="#8b5cf6" strokeWidth="1.5">
        <circle cx="118" cy="266" r="4.2" />
        <circle cx="318" cy="300" r="4.2" />
      </g>

      <g>
        <path
          d="M468 245L439 295H381L352 245L381 195H439Z"
          fill="#ffffff"
          fillOpacity="0.72"
          stroke="#26303f"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
        <circle cx="410" cy="245" r="33" fill="none" stroke="#3f6df0" strokeWidth="1.5" opacity="0.7" />
        <path d="M468 245L504 232" stroke="#26303f" strokeWidth="1.8" strokeLinecap="round" />
        <text
          x="508"
          y="236"
          fontFamily="Segoe UI, Microsoft YaHei, sans-serif"
          fontSize="14"
          fontWeight="600"
          fill="#26303f"
        >
          OH
        </text>
        <path d="M352 245H330" stroke="#26303f" strokeWidth="1.8" strokeLinecap="round" />
        <text
          x="296"
          y="250"
          fontFamily="Segoe UI, Microsoft YaHei, sans-serif"
          fontSize="13"
          fontWeight="600"
          fill="#26303f"
        >
          N
        </text>
      </g>

      <g filter="url(#art-shadow)">
        <rect x="52" y="42" width="188" height="42" rx="11" fill="#ffffff" />
      </g>
      <g stroke="#5a6375" strokeWidth="1.4" fill="none">
        <path d="M71 57l7 12 4-8z" />
        <rect x="94" y="57" width="10" height="10" rx="1.4" />
        <circle cx="121" cy="62" r="5.4" />
        <path d="M147 55l-5 14M156 55l5 14" />
        <path d="M174 62h12M180 56v12" />
      </g>
      <path d="M78 42v42" stroke="#eef1f6" />
      <path d="M162 42v42" stroke="#eef1f6" />

      <g filter="url(#art-chip-shadow)">
        <rect x="330" y="52" width="176" height="34" rx="17" fill="#ffffff" />
      </g>
      <circle cx="349" cy="69" r="3.4" fill="#0f9d8f" />
      <text
        x="360"
        y="73.5"
        fontFamily="Segoe UI, Microsoft YaHei, sans-serif"
        fontSize="11.5"
        fill="#5a6375"
      >
        本地运行 · 无需云端
      </text>

      <g transform="translate(60 340)">
        <rect width="126" height="26" rx="13" fill="#ffffff" opacity="0.9" />
        <text
          x="14"
          y="17"
          fontFamily="Segoe UI, Microsoft YaHei, sans-serif"
          fontSize="10.5"
          fill="#6b7385"
        >
          贝塞尔路径 · 节点
        </text>
      </g>
    </svg>
  );
}
