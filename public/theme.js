// Applies the saved theme before first paint ("auto" follows the OS). Loaded in <head>.
try {
  const t = localStorage.getItem("mex-theme");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
} catch { /* storage blocked: follow the OS */ }
