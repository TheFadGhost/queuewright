// Read-only contrast auditor: WCAG 2.x relative luminance / contrast ratio.
// Tokens transcribed verbatim from dashboard-assets/styles.css lines 1-21.
const THEMES = {
  light: {
    bg: "#ffffff", bgSunken: "#f4f6f8", fg: "#1a2129", fgMuted: "#5b6875",
    states: {
      queued: "#57606a", scheduled: "#7d6600", running: "#0b62d6", succeeded: "#116e32",
      retrying: "#b45309", failed: "#b3261e", dead: "#7c1d6f", cancelled: "#5b6875",
    },
  },
  dark: {
    bg: "#101418", bgSunken: "#171d24", fg: "#e6ebf0", fgMuted: "#97a4b0",
    states: {
      queued: "#8b949e", scheduled: "#c9a227", running: "#58a6ff", succeeded: "#3fb950",
      retrying: "#f0883e", failed: "#ff6b63", dead: "#db61a2", cancelled: "#97a4b0",
    },
  },
  "high-contrast": {
    bg: "#ffffff", bgSunken: "#eef1f4", fg: "#000000", fgMuted: "#333c44",
    states: {
      queued: "#444c54", scheduled: "#6b5200", running: "#004ea8", succeeded: "#0a5426",
      retrying: "#8a3c00", failed: "#8f1109", dead: "#5c1140", cancelled: "#444c54",
    },
  },
};

function lin(c8) {
  const c = c8 / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function lum(hex) {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function ratio(fgHex, bgHex) {
  const l1 = lum(fgHex), l2 = lum(bgHex);
  const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

let fails = 0;
for (const [theme, t] of Object.entries(THEMES)) {
  console.log(`\n=== theme: ${theme} (bg ${t.bg} L=${lum(t.bg).toFixed(4)}) ===`);
  const rows = [
    ["--fg (body text)", t.fg],
    ["--fg-muted (axis labels)", t.fgMuted],
    ...Object.entries(t.states).map(([k, v]) => [`--st-${k}`, v]),
  ];
  for (const [name, hex] of rows) {
    const rBg = ratio(hex, t.bg);
    const rSun = ratio(hex, t.bgSunken);
    const passBg = rBg >= 4.5, passSun = rSun >= 4.5;
    if (!passBg || !passSun) fails++;
    console.log(
      `${name.padEnd(26)} ${hex}  on --bg ${t.bg}: (${(lum(hex).toFixed(4) + "+0.05")}/${(lum(t.bg).toFixed(4) + "+0.05")}) = ${rBg.toFixed(2)}:1 ${passBg ? "PASS" : "**FAIL**"}   on --bg-sunken ${t.bgSunken}: ${rSun.toFixed(2)}:1 ${passSun ? "PASS" : "**FAIL**"}`
    );
  }
}
console.log(`\nAA failures (normal-size text, 4.5:1 threshold): ${fails}`);
