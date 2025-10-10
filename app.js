/* ======================================================
   app.js — Splash “sofy” + carga dinámica + animaciones
   ====================================================== */

// Utilidades seguras
const escapeHTML = (str) =>
  String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const normalizeTags = (tags) =>
  (Array.isArray(tags) ? tags : [])
    .map(t => String(t).toLowerCase().trim())
    .filter(Boolean)
    .slice(0, 10);

// Estado splash
let splashMinShown = false;     // asegura un tiempo mínimo visible
let galleryReady = false;       // se pone true cuando la galería terminó de renderizar

// DOM listo
document.addEventListener("DOMContentLoaded", () => {
  const yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  const ctaBtn = document.getElementById("ctaBtn");
  if (ctaBtn) {
    ctaBtn.addEventListener("click", () => {
      document.querySelector("#galeria")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  // Menú móvil
  const navToggle = document.getElementById("navToggle");
  const navMenu = document.getElementById("navMenu");
  if (navToggle && navMenu) {
    navToggle.addEventListener("click", () => {
      const open = document.body.classList.toggle("is-menu-open");
      navToggle.setAttribute("aria-expanded", String(open));
    });
    // Cierra al elegir un link
    navMenu.addEventListener("click", (e) => {
      if (e.target.closest("a")) {
        document.body.classList.remove("is-menu-open");
        navToggle.setAttribute("aria-expanded", "false");
      }
    });
  }

  // Mantener splash al menos 900 ms
  setTimeout(() => { splashMinShown = true; maybeHideSplash(); }, 900);

  // Cargar galería
  loadGallery().finally(() => {
    galleryReady = true;
    maybeHideSplash();
  });
});

// Esconde el splash cuando se cumpla el tiempo mínimo y la galería está lista
function maybeHideSplash(){
  const splash = document.getElementById("splash");
  if (!splash) return;
  if (splashMinShown && galleryReady){
    splash.classList.add("is-hiding");
    // Remover del flujo tras la transición
    setTimeout(() => splash.remove(), 650);
  }
}

// Carga la galería desde data.json
async function loadGallery(){
  const status = document.getElementById("galleryStatus");
  try{
    if (status) { status.style.display = "block"; status.textContent = "Cargando…"; }
    const res = await fetch("./data.json", { cache: "no-store" }); // evitar cache
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const items = await res.json();
    renderGallery(Array.isArray(items) ? items : []);
    if (status) status.style.display = "none";
  }catch(err){
    console.error("[gallery] error:", err);
    if (status) {
      status.style.display = "block";
      status.textContent = "No se pudo cargar la galería. Verificá que data.json exista.";
    }
  }
}

// Render de cards + animación al hacer scroll
function renderGallery(items){
  const section = document.getElementById("galeria");
  if (!section) return;

  // grid
  const grid = document.createElement("div");
  grid.className = "grid";

  for (const item of items){
    const title = escapeHTML(item.title);
    const description = escapeHTML(item.description);
    const image = String(item.image || "");
    const tags = normalizeTags(item.tags ?? []);

    const card = document.createElement("article");
    card.className = "card";

    const media = document.createElement("div");
    media.className = "card-media";

    const img = document.createElement("img");
    img.loading = "lazy";
    img.alt = title || "Imagen";
    img.src = image;
    media.appendChild(img);

    const body = document.createElement("div");
    body.className = "card-body";

    const h3 = document.createElement("h3");
    h3.className = "card-title";
    h3.textContent = title;

    const p = document.createElement("p");
    p.className = "card-desc";
    p.textContent = description;

    const tagWrap = document.createElement("div");
    tagWrap.className = "tags";
    tags.forEach(t => {
      const chip = document.createElement("span");
      chip.className = "tag";
      chip.textContent = `#${t}`;
      tagWrap.appendChild(chip);
    });

    body.append(h3, p, tagWrap);
    card.append(media, body);
    grid.appendChild(card);
  }

  // Limpia y monta
  section.innerHTML = "";
  section.appendChild(grid);

  // IntersectionObserver para fade-in + slide-up
  const observer = new IntersectionObserver((entries, obs) => {
    for (const entry of entries){
      if (entry.isIntersecting){
        entry.target.classList.add("is-visible");
        obs.unobserve(entry.target);
      }
    }
  }, { rootMargin: "0px 0px -10% 0px", threshold: 0.1 });

  document.querySelectorAll(".card").forEach(el => observer.observe(el));
}