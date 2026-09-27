/* ============================================================
   LIONEL MESSI — TRIBUTE
   script.js

   Sections:
   1. Gaze Controller   — the core cursor/touch → video timestamp
                           system. This is a refined version of the
                           original mousemove handler: same angle
                           math, same direction→timestamp mapping,
                           now running off requestAnimationFrame
                           with a dead zone + hysteresis so the
                           direction doesn't flicker at the seams.
   2. Webcam Gaze (opt.) — optional head-position based tracking
                           that feeds the same 9 directions into
                           the same controller. Falls back to
                           cursor tracking automatically.
   3. Navigation         — scroll state + tracking status pill.
   4. Scroll Reveals     — IntersectionObserver fade-ins + the
                           legacy counters.
   5. Uploader           — local, in-browser video preview.
   6. Farewell particles — small decorative flourish.
   ============================================================ */

(() => {
  "use strict";

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ============================================================
     1. GAZE CONTROLLER
     ============================================================ */

  const GazeController = (() => {
    const video = document.getElementById("bg-video");

    // Preserved, unmodified direction → timestamp mapping.
    const DIRECTION_TIME = {
      CENTER: 0.0,
      TOP: 1.05,
      "TOP-RIGHT": 2.02,
      RIGHT: 2.14,
      "BOTTOM-RIGHT": 3.14,
      BOTTOM: 4.0,
      "BOTTOM-LEFT": 4.22,
      LEFT: 5.04,
      "TOP-LEFT": 6.05,
    };

    const DEAD_ZONE_PX = 60;       // radius around center that always means CENTER
    const HYSTERESIS_DEG = 4;      // extra angle a zone boundary must be crossed by
                                    // before we switch directions (stops flicker)

    // 45°-wide slices, centered on each compass direction.
    const ZONES = [
      { name: "RIGHT", center: 0 },
      { name: "BOTTOM-RIGHT", center: 45 },
      { name: "BOTTOM", center: 90 },
      { name: "BOTTOM-LEFT", center: 135 },
      { name: "LEFT", center: 180 },
      { name: "TOP-LEFT", center: 225 },
      { name: "TOP", center: 270 },
      { name: "TOP-RIGHT", center: 315 },
    ];

    let targetX = window.innerWidth / 2;
    let targetY = window.innerHeight / 2;
    let currentDirection = "CENTER";
    let rafId = null;
    let hasInput = false;

    const listeners = new Set();
    function onDirectionChange(fn) { listeners.add(fn); }
    function emit(direction) { listeners.forEach((fn) => fn(direction)); }

    function angleDelta(a, b) {
      let d = Math.abs(a - b) % 360;
      return d > 180 ? 360 - d : d;
    }

    function resolveZone(angle) {
      // Prefer staying in the current zone unless the cursor has moved
      // clearly (by HYSTERESIS_DEG) past its boundary into a new one.
      let best = ZONES[0];
      let bestDelta = Infinity;
      for (const zone of ZONES) {
        const d = angleDelta(angle, zone.center);
        if (d < bestDelta) {
          bestDelta = d;
          best = zone;
        }
      }

      if (currentDirection !== "CENTER") {
        const currentZone = ZONES.find((z) => z.name === currentDirection);
        if (currentZone) {
          const currentDelta = angleDelta(angle, currentZone.center);
          // Stay put unless the new best zone clearly wins.
          if (currentDelta - bestDelta < HYSTERESIS_DEG) {
            return currentZone.name;
          }
        }
      }
      return best.name;
    }

    function setDirection(direction) {
      if (direction === currentDirection) return;
      currentDirection = direction;
      const t = DIRECTION_TIME[direction];
      if (Math.abs(video.currentTime - t) > 0.005) {
        video.currentTime = t;
      }
      emit(direction);
    }

    function tick() {
      const centerX = window.innerWidth / 2;
      const centerY = window.innerHeight / 2;
      const deltaX = targetX - centerX;
      const deltaY = targetY - centerY;
      const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

      if (distance < DEAD_ZONE_PX) {
        setDirection("CENTER");
      } else {
        let angle = Math.atan2(deltaY, deltaX) * (180 / Math.PI);
        if (angle < 0) angle += 360;
        setDirection(resolveZone(angle));
      }

      rafId = requestAnimationFrame(tick);
    }

    function start() {
      if (rafId === null) rafId = requestAnimationFrame(tick);
    }

    function setTarget(x, y) {
      targetX = x;
      targetY = y;
      if (!hasInput) {
        hasInput = true;
        emit("__ACTIVE__");
      }
    }

    function init() {
      if (video.readyState === 0) {
        video.load();
      }
      video.addEventListener("loadedmetadata", () => {
        // Some browsers won't paint a paused video's first frame until a
        // seek or a play/pause cycle actually happens. Nudge it once so
        // the character is visible before any cursor movement occurs.
        const paintFirstFrame = () => {
          video.play()
            .then(() => video.pause())
            .catch(() => {
              video.currentTime = 0.001;
            });
        };
        paintFirstFrame();
      });

      window.addEventListener(
        "mousemove",
        (e) => setTarget(e.clientX, e.clientY),
        { passive: true }
      );

      // Touch support: the character follows a finger drag anywhere
      // on the page, so mobile visitors get the same interaction.
      window.addEventListener(
        "touchmove",
        (e) => {
          if (e.touches && e.touches[0]) {
            setTarget(e.touches[0].clientX, e.touches[0].clientY);
          }
        },
        { passive: true }
      );

      start();
    }

    return { init, onDirectionChange, setTarget, get hasInput() { return hasInput; } };
  })();

  /* ============================================================
     2. WEBCAM GAZE (optional, off by default)
     ============================================================ */

  const WebcamGaze = (() => {
    let stream = null;
    let videoEl = null;
    let canvas = null;
    let ctx = null;
    let rafId = null;
    let detector = null;
    let active = false;

    async function enable(statusCallback) {
      if (!("FaceDetector" in window)) {
        statusCallback("unsupported");
        return false;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 320, height: 240 },
          audio: false,
        });
      } catch (err) {
        statusCallback("denied");
        return false;
      }

      videoEl = document.createElement("video");
      videoEl.srcObject = stream;
      videoEl.muted = true;
      videoEl.playsInline = true;
      await videoEl.play();

      canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 240;
      ctx = canvas.getContext("2d", { willReadFrequently: true });

      // eslint-disable-next-line no-undef
      detector = new FaceDetector({ fastMode: true, maxDetectedFaces: 1 });

      active = true;
      statusCallback("active");
      loop();
      return true;
    }

    async function loop() {
      if (!active) return;
      try {
        ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
        const faces = await detector.detect(canvas);
        if (faces && faces[0]) {
          const box = faces[0].boundingBox;
          const faceCenterX = box.x + box.width / 2;
          const faceCenterY = box.y + box.height / 2;
          // Map the face's offset from the frame center onto the full
          // viewport, inverted on X because the camera mirrors the face
          // (moving your head right shifts the detected box left).
          const nx = (faceCenterX - canvas.width / 2) / (canvas.width / 2);
          const ny = (faceCenterY - canvas.height / 2) / (canvas.height / 2);
          const vx = window.innerWidth / 2 - nx * (window.innerWidth / 2);
          const vy = window.innerHeight / 2 + ny * (window.innerHeight / 2);
          GazeController.setTarget(vx, vy);
        }
      } catch (err) {
        /* detection hiccup — just try again next frame */
      }
      rafId = requestAnimationFrame(loop);
    }

    function disable() {
      active = false;
      if (rafId) cancelAnimationFrame(rafId);
      if (stream) stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }

    return { enable, disable, get active() { return active; } };
  })();

  /* ============================================================
     3. NAVIGATION
     ============================================================ */

  function initNav() {
    const nav = document.querySelector(".nav");
    const status = document.querySelector(".nav-status");
    const toggle = document.querySelector(".nav-toggle");
    const links = document.querySelector(".nav-links");
    const hero = document.querySelector(".hero");

    window.addEventListener(
      "scroll",
      () => {
        nav.classList.toggle("scrolled", window.scrollY > 40);
      },
      { passive: true }
    );

    GazeController.onDirectionChange((direction) => {
      if (direction === "__ACTIVE__") {
        status.classList.add("active");
        status.querySelector(".label").textContent = "TRACKING ACTIVE";
        hero.classList.add("tracking-live");
      }
    });

    if (toggle) {
      toggle.addEventListener("click", () => {
        const open = links.classList.toggle("nav-links-open");
        toggle.setAttribute("aria-expanded", String(open));
      });
      links.querySelectorAll("a").forEach((a) =>
        a.addEventListener("click", () => {
          links.classList.remove("nav-links-open");
          toggle.setAttribute("aria-expanded", "false");
        })
      );
    }

    const eyeToggle = document.getElementById("eye-tracking-toggle");
    if (eyeToggle) {
      eyeToggle.addEventListener("click", async () => {
        if (WebcamGaze.active) {
          WebcamGaze.disable();
          eyeToggle.textContent = "Enable eye tracking";
          eyeToggle.setAttribute("aria-pressed", "false");
          return;
        }
        eyeToggle.textContent = "Requesting camera…";
        const ok = await WebcamGaze.enable((state) => {
          if (state === "active") {
            eyeToggle.textContent = "Disable eye tracking";
            eyeToggle.setAttribute("aria-pressed", "true");
          } else if (state === "denied") {
            eyeToggle.textContent = "Camera denied — using cursor";
            setTimeout(() => (eyeToggle.textContent = "Enable eye tracking"), 2500);
          } else if (state === "unsupported") {
            eyeToggle.textContent = "Not supported — using cursor";
            eyeToggle.disabled = true;
          }
        });
        if (!ok) eyeToggle.setAttribute("aria-pressed", "false");
      });
    }
  }

  /* ============================================================
     4. SCROLL REVEALS + LEGACY COUNTERS
     ============================================================ */

  function initReveals() {
    const revealEls = document.querySelectorAll(".reveal");
    if (reducedMotion || !("IntersectionObserver" in window)) {
      revealEls.forEach((el) => el.classList.add("in-view"));
    } else {
      const io = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) {
              entry.target.classList.add("in-view");
              io.unobserve(entry.target);
            }
          });
        },
        { threshold: 0.15 }
      );
      revealEls.forEach((el) => io.observe(el));
    }

    const counters = document.querySelectorAll(".timeline-number[data-count]");
    const countIO = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const el = entry.target;
          const target = parseInt(el.dataset.count, 10);
          if (reducedMotion) {
            el.textContent = String(target).padStart(2, "0");
          } else {
            const duration = 900;
            const start = performance.now();
            function step(now) {
              const p = Math.min(1, (now - start) / duration);
              const eased = 1 - Math.pow(1 - p, 3);
              el.textContent = String(Math.round(eased * target)).padStart(2, "0");
              if (p < 1) requestAnimationFrame(step);
            }
            requestAnimationFrame(step);
          }
          countIO.unobserve(el);
        });
      },
      { threshold: 0.6 }
    );
    counters.forEach((el) => countIO.observe(el));
  }

  /* ============================================================
     5. UPLOADER
     ============================================================ */

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function formatDuration(seconds) {
    if (!isFinite(seconds)) return "—";
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function initUploader() {
    const zone = document.getElementById("uploader");
    if (!zone) return;
    const input = document.getElementById("upload-input");
    const browseBtn = document.getElementById("upload-browse");
    const preview = document.getElementById("upload-preview");
    const previewVideo = document.getElementById("upload-preview-video");
    const fname = document.getElementById("upload-filename");
    const fdetails = document.getElementById("upload-filedetails");
    const playBtn = document.getElementById("upload-play");
    const removeBtn = document.getElementById("upload-remove");

    let objectUrl = null;

    function loadFile(file) {
      if (!file || !file.type.startsWith("video/")) return;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = URL.createObjectURL(file);
      previewVideo.src = objectUrl;
      fname.textContent = file.name;
      fdetails.textContent = `${formatBytes(file.size)} · loading…`;
      previewVideo.addEventListener(
        "loadedmetadata",
        () => {
          fdetails.textContent = `${formatBytes(file.size)} · ${formatDuration(previewVideo.duration)}`;
        },
        { once: true }
      );
      zone.classList.add("has-file");
      preview.classList.add("active");
      playBtn.textContent = "Play";
    }

    function reset() {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = null;
      previewVideo.pause();
      previewVideo.removeAttribute("src");
      previewVideo.load();
      zone.classList.remove("has-file");
      preview.classList.remove("active");
      input.value = "";
    }

    browseBtn.addEventListener("click", () => input.click());
    input.addEventListener("change", (e) => loadFile(e.target.files[0]));

    ["dragenter", "dragover"].forEach((evt) =>
      zone.addEventListener(evt, (e) => {
        e.preventDefault();
        zone.classList.add("drag-over");
      })
    );
    ["dragleave", "drop"].forEach((evt) =>
      zone.addEventListener(evt, (e) => {
        e.preventDefault();
        zone.classList.remove("drag-over");
      })
    );
    zone.addEventListener("drop", (e) => {
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      loadFile(file);
    });

    playBtn.addEventListener("click", () => {
      if (previewVideo.paused) {
        previewVideo.play();
        playBtn.textContent = "Pause";
      } else {
        previewVideo.pause();
        playBtn.textContent = "Play";
      }
    });
    previewVideo.addEventListener("ended", () => (playBtn.textContent = "Play"));
    removeBtn.addEventListener("click", reset);
  }

  /* ============================================================
     6. FAREWELL PARTICLES
     ============================================================ */

  function initParticles() {
    if (reducedMotion) return;
    const host = document.getElementById("farewell-particles");
    if (!host) return;
    const count = window.innerWidth < 700 ? 14 : 28;
    for (let i = 0; i < count; i++) {
      const p = document.createElement("span");
      p.className = "particle";
      p.style.left = `${Math.random() * 100}%`;
      p.style.animationDuration = `${8 + Math.random() * 10}s`;
      p.style.animationDelay = `${Math.random() * 10}s`;
      host.appendChild(p);
    }
  }

  /* ============================================================
     INIT
     ============================================================ */

  document.addEventListener("DOMContentLoaded", () => {
    GazeController.init();
    initNav();
    initReveals();
    initUploader();
    initParticles();
  });
})();
